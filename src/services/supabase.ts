import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { ConfiguracionBusqueda, PropiedadEntrada, PropiedadBD, HistorialPrecio } from '../types/index.js';
import { notificarBajaPrecio, notificarOportunidad } from './telegram.js';

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_KEY || '';

export const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
  realtime: {
    params: {
      eventsPerSecond: 0,
    },
  },
});

export async function obtenerConfiguracionActiva(): Promise<ConfiguracionBusqueda> {
  const { data, error } = await supabase
    .from('configuracion_busqueda')
    .select('*')
    .eq('activo', true)
    .limit(1);

  if (error) {
    throw new Error(`Error al obtener la configuración activa: ${error.message}`);
  }

  if (!data || data.length === 0) {
    throw new Error('No se encontró ninguna configuración de búsqueda activa en la base de datos.');
  }

  return data[0] as ConfiguracionBusqueda;
}

export async function procesarInmueble(
  item: PropiedadEntrada,
  config: ConfiguracionBusqueda
): Promise<void> {
  // a. Skip if area_m2 < config.area_minima_m2
  if (item.area_m2 < config.area_minima_m2) {
    return;
  }

  // b. Skip if localidad NOT in config.localidades_permitidas
  if (!config.localidades_permitidas.includes(item.localidad)) {
    return;
  }

  // c. Skip if estrato NOT in config.estratos_permitidos
  if (item.estrato !== undefined && !config.estratos_permitidos.includes(item.estrato)) {
    return;
  }

  // d. Skip if parqueaderos < config.parqueaderos_minimos or (!config.permitir_parqueadero_comunal && tipo_parqueadero === 'comunal')
  const numParqueaderos = item.parqueaderos ?? 0;
  if (numParqueaderos < config.parqueaderos_minimos) {
    return;
  }
  if (!config.permitir_parqueadero_comunal && item.tipo_parqueadero === 'comunal') {
    return;
  }

  // e. Skip if (valor_administracion / precio_venta) > config.porcentaje_max_administracion
  if (item.valor_administracion !== undefined && item.precio_venta > 0) {
    const relacionAdmin = item.valor_administracion / item.precio_venta;
    const maxAdmin = config.porcentaje_max_administracion > 1
      ? config.porcentaje_max_administracion / 100
      : config.porcentaje_max_administracion;
    if (relacionAdmin > maxAdmin) {
      return;
    }
  }

  // Check existing record in propiedades using (portal_origen, id_anuncio_externo)
  const { data: existente, error: errorBusqueda } = await supabase
    .from('propiedades')
    .select('*')
    .eq('portal_origen', item.portal_origen)
    .eq('id_anuncio_externo', item.id_anuncio_externo)
    .maybeSingle();

  if (errorBusqueda) {
    console.error(`Error al buscar propiedad existente (${item.portal_origen} / ${item.id_anuncio_externo}):`, errorBusqueda.message);
  }

  const id_anuncio_externo = item.id_anuncio_externo ? item.id_anuncio_externo.trim().substring(0, 49) : item.id_anuncio_externo;
  const url_anuncio = item.url_anuncio ? item.url_anuncio.split('?')[0].trim().substring(0, 1999) : item.url_anuncio;
  const titulo = item.titulo ? item.titulo.trim().substring(0, 99) : undefined;
  const barrio_normalizado = item.barrio_normalizado ? item.barrio_normalizado.trim().substring(0, 99) : undefined;

  const payload = {
    ...item,
    id_anuncio_externo,
    url_anuncio,
    titulo,
    barrio_normalizado,
    fecha_extraido: new Date().toISOString(),
    activo: true,
  };

  // Upsert payload into propiedades table on conflict (portal_origen, id_anuncio_externo)
  const { data: propiedadGuardada, error: errUpsert } = await supabase
    .from('propiedades')
    .upsert(payload, {
      onConflict: 'portal_origen,id_anuncio_externo',
      ignoreDuplicates: false,
    })
    .select('*')
    .single();

  if (errUpsert) {
    console.error(`[Supabase] Error en upsert de propiedad (${item.portal_origen} / ${id_anuncio_externo}):`, errUpsert.message);
    return;
  }

  const propActual = (propiedadGuardada as PropiedadBD) || { ...payload, id: '' };
  const precio_m2 = item.area_m2 > 0 ? item.precio_venta / item.area_m2 : 0;

  if (existente) {
    // IF exists AND new precio_venta < old precio_venta
    if (item.precio_venta < existente.precio_venta) {
      const precioAnterior = existente.precio_venta;
      const precioNuevo = item.precio_venta;
      const porcentaje_cambio = Number((((precioNuevo - precioAnterior) / precioAnterior) * 100).toFixed(2));

      // Insert into historial_precios
      const historialItem: Partial<HistorialPrecio> = {
        propiedad_id: existente.id,
        precio_anterior: precioAnterior,
        precio_nuevo: precioNuevo,
        porcentaje_cambio,
        fecha_cambio: new Date().toISOString(),
      };

      const { error: errHistorial } = await supabase
        .from('historial_precios')
        .insert(historialItem);

      if (errHistorial) {
        console.error('Error insertando en historial_precios:', errHistorial.message);
      }

      // Call notificarBajaPrecio() from ./telegram.js
      const porcentajeBaja = Math.abs(porcentaje_cambio);
      await notificarBajaPrecio(propActual, precioAnterior, porcentajeBaja);
    }
  } else {
    // IF NOT exists: Compare precio_m2 against barrios_bogota average for that barrio
    if (item.barrio_normalizado) {
      try {
        const { data: barrioInfo, error: errBarrio } = await supabase
          .from('barrios_bogota')
          .select('precio_promedio_m2, estrato_predominante')
          .eq('localidad', item.localidad)
          .eq('barrio_normalizado', item.barrio_normalizado)
          .maybeSingle();

        if (errBarrio) {
          console.warn(`[Supabase] Advertencia: No se pudo consultar barrios_bogota para "${item.barrio_normalizado}" en ${item.localidad}:`, errBarrio.message);
        } else if (barrioInfo && barrioInfo.precio_promedio_m2 && barrioInfo.precio_promedio_m2 > 0) {
          const promedioBarrio = barrioInfo.precio_promedio_m2;
          const porcentajeDescuento = ((promedioBarrio - precio_m2) / promedioBarrio) * 100;

          if (porcentajeDescuento >= config.porcentaje_descuento_alerta) {
            // Call notificarOportunidad() from ./telegram.js
            await notificarOportunidad(propActual, porcentajeDescuento, promedioBarrio);
          }
        }
      } catch (err: any) {
        console.warn(`[Supabase] Excepción al consultar barrio "${item.barrio_normalizado}":`, err?.message || err);
      }
    }
  }
}

export async function procesarInmueblesBatch(
  items: PropiedadEntrada[],
  config: ConfiguracionBusqueda
): Promise<void> {
  for (const item of items) {
    try {
      await procesarInmueble(item, config);
    } catch (err: any) {
      console.error(`[Supabase Batch] Error procesando inmueble (${item.id_anuncio_externo}):`, err?.message || err);
    }
  }
}

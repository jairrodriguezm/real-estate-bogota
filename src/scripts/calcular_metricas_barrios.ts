import dotenv from 'dotenv';
import { supabase } from '../services/supabase.js';

dotenv.config();

interface PropiedadCalculo {
  id: string;
  id_anuncio_externo: string;
  barrio_normalizado: string | null;
  area_m2: number;
  precio_venta: number;
  precio_m2: number;
  valor_administracion: number | null;
  habitaciones: number | null;
  banos: number | null;
  url_anuncio: string | null;
}

interface MetricaBarrio {
  barrio_normalizado: string;
  total_inmuebles: number;
  precio_m2_promedio: number;
  precio_m2_mediana: number;
  precio_m2_minimo: number;
  precio_m2_maximo: number;
}

async function main() {
  console.log('[Metricas] Consultando propiedades activas de Supabase...');

  // 1. Query active properties from Supabase
  const { data: propiedades, error } = await supabase
    .from('propiedades')
    .select('id, id_anuncio_externo, barrio_normalizado, area_m2, precio_venta, precio_m2, valor_administracion, habitaciones, banos, url_anuncio')
    .eq('activo', true)
    .not('precio_m2', 'is', null)
    .gt('area_m2', 0);

  if (error) {
    console.error('[Metricas Error] Error consultando propiedades activas:', error.message);
    process.exit(1);
  }

  if (!propiedades || propiedades.length === 0) {
    console.log('[Metricas] No se encontraron propiedades activas para analizar.');
    process.exit(0);
  }

  console.log(`[Metricas] Se obtuvieron ${propiedades.length} propiedades activas.`);

  // 2. Group and Calculate Metrics per Neighborhood (barrio_normalizado)
  const agrupadoPorBarrio: Record<string, PropiedadCalculo[]> = {};

  for (const prop of propiedades as PropiedadCalculo[]) {
    if (!prop.barrio_normalizado) continue;
    const barrio = prop.barrio_normalizado.trim();
    if (!barrio) continue;

    if (!agrupadoPorBarrio[barrio]) {
      agrupadoPorBarrio[barrio] = [];
    }
    agrupadoPorBarrio[barrio].push(prop);
  }

  const metricasArray: MetricaBarrio[] = [];
  const promediosPorBarrio: Map<string, number> = new Map();

  for (const [barrio, props] of Object.entries(agrupadoPorBarrio)) {
    // For each neighborhood with at least 3 active listings
    if (props.length < 3) continue;

    const total_inmuebles = props.length;
    const preciosM2 = props.map((p) => Number(p.precio_m2)).sort((a, b) => a - b);

    const suma = preciosM2.reduce((acc, val) => acc + val, 0);
    const precio_m2_promedio = Math.round(suma / total_inmuebles);

    // Calculate exact median precio_m2
    let precio_m2_mediana: number;
    const n = preciosM2.length;
    if (n % 2 !== 0) {
      precio_m2_mediana = Math.round(preciosM2[Math.floor(n / 2)]);
    } else {
      precio_m2_mediana = Math.round((preciosM2[n / 2 - 1] + preciosM2[n / 2]) / 2);
    }

    const precio_m2_minimo = Math.round(preciosM2[0]);
    const precio_m2_maximo = Math.round(preciosM2[n - 1]);

    metricasArray.push({
      barrio_normalizado: barrio,
      total_inmuebles,
      precio_m2_promedio,
      precio_m2_mediana,
      precio_m2_minimo,
      precio_m2_maximo,
    });

    promediosPorBarrio.set(barrio, precio_m2_promedio);
  }

  // 3. Upsert Neighborhood Metrics into barrios_metricas
  if (metricasArray.length > 0) {
    const { error: upsertError } = await supabase
      .from('barrios_metricas')
      .upsert(metricasArray, { onConflict: 'barrio_normalizado' });

    if (upsertError) {
      console.error('[Metricas Error] Error actualizando barrios_metricas:', upsertError.message);
    } else {
      console.log(`[Metricas] Métricas upserted con éxito para ${metricasArray.length} barrios.`);
    }
  } else {
    console.log('[Metricas] Ningún barrio cumple con el mínimo de 3 inmuebles activos.');
  }

  // 4. Identify Undervalued Properties (Bargain Detector)
  const subvaloradas: Array<{
    barrio: string;
    precio: number;
    area_m2: number;
    precio_m2: number;
    promedio_barrio: number;
    descuento_pct: number;
    admin: number | null;
    url: string;
  }> = [];

  for (const prop of propiedades as PropiedadCalculo[]) {
    if (!prop.barrio_normalizado) continue;
    const barrio = prop.barrio_normalizado.trim();
    const promedio = promediosPorBarrio.get(barrio);
    if (!promedio) continue;

    const pM2 = Number(prop.precio_m2);
    if (pM2 < promedio) {
      const descuento_pct = Number((((promedio - pM2) / promedio) * 100).toFixed(2));
      subvaloradas.push({
        barrio,
        precio: prop.precio_venta,
        area_m2: prop.area_m2,
        precio_m2: pM2,
        promedio_barrio: promedio,
        descuento_pct,
        admin: prop.valor_administracion ?? null,
        url: prop.url_anuncio || 'N/A',
      });
    }
  }

  // Sort properties by descuento_pct descending
  subvaloradas.sort((a, b) => b.descuento_pct - a.descuento_pct);

  // 5. Output Results in Terminal
  console.log('\n======================================================');
  console.log(` RESUMEN: ${metricasArray.length} barrios actualizados`);
  console.log(` Inmuebles subvalorados identificados: ${subvaloradas.length}`);
  console.log('======================================================\n');

  const formatCOP = (val: number) =>
    new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(val);

  const top15 = subvaloradas.slice(0, 15).map((item) => ({
    'Barrio': item.barrio,
    'Precio': formatCOP(item.precio),
    'Area m2': item.area_m2,
    'Precio m2': formatCOP(item.precio_m2),
    'Prom. Barrio': formatCOP(item.promedio_barrio),
    'Descuento %': `${item.descuento_pct}%`,
    'Admin': item.admin ? formatCOP(item.admin) : '$0',
    'URL': item.url,
  }));

  console.log('TOP 15 OPORTUNIDADES (PROPIEDADES SUBVALORADAS):');
  console.table(top15);
}

main().catch((err) => {
  console.error('[Metricas Error] Error no controlado en ejecucion:', err);
  process.exit(1);
});

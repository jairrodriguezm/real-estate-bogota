import { ConfiguracionBusqueda, PropiedadEntrada, TipoParqueadero } from '../types/index.js';
import { normalizarLocalidad, normalizarBarrio } from '../utils/normalizer.js';

function parseAlgoliaHit(hit: any): PropiedadEntrada | null {
  if (!hit) return null;

  const id = String(
    hit.objectID ||
    hit.id ||
    hit.code ||
    hit.listing_id ||
    hit.property_id ||
    ''
  ).trim();

  if (!id) return null;

  let url = hit.link || hit.url || hit.slug || '';
  if (url && !url.startsWith('http')) {
    url = `https://www.fincaraiz.com.co${url.startsWith('/') ? '' : '/'}${url}`;
  }
  if (!url) {
    url = `https://www.fincaraiz.com.co/inmueble/${id}`;
  }

  const precio = Number(
    hit.price ||
    hit.precio ||
    hit.price_sale ||
    hit.pricing?.price ||
    hit.precio_venta ||
    0
  );

  if (isNaN(precio) || precio <= 0) return null;

  const area = Number(
    hit.built_area ||
    hit.area ||
    hit.surface ||
    hit.area_m2 ||
    hit.area_built ||
    0
  );

  if (isNaN(area) || area <= 0) return null;

  const locTexto = String(
    hit.location?.city_area?.name ||
    hit.location?.zone ||
    hit.location?.name ||
    hit.localidad?.name ||
    hit.localidad ||
    hit.city_area ||
    hit.location_name ||
    hit.zone ||
    ''
  );

  const localidad = normalizarLocalidad(locTexto);
  if (!localidad) return null;

  const titulo = hit.title || hit.titulo || hit.name || undefined;
  const descripcion = hit.description || hit.descripcion || undefined;

  const rawAdmin = hit.admin_fee ?? hit.valor_administracion ?? hit.pricing?.admin_fee;
  const valor_administracion = rawAdmin !== undefined && rawAdmin !== null ? Number(rawAdmin) : undefined;

  const rawEstrato = hit.stratum ?? hit.estrato;
  const estrato = rawEstrato !== undefined && rawEstrato !== null ? Number(rawEstrato) : undefined;

  const rawParq = hit.parking_spaces ?? hit.garages ?? hit.parqueaderos;
  const parqueaderos = rawParq !== undefined && rawParq !== null ? Number(rawParq) : undefined;

  let tipo_parqueadero: TipoParqueadero | undefined = undefined;
  const rawTipoP = String(hit.parking_type || hit.tipo_parqueadero || '').toLowerCase();
  if (rawTipoP.includes('privado')) tipo_parqueadero = 'privado';
  else if (rawTipoP.includes('servidumbre')) tipo_parqueadero = 'servidumbre';
  else if (rawTipoP.includes('comunal')) tipo_parqueadero = 'comunal';

  const rawHab = hit.bedrooms ?? hit.rooms ?? hit.habitaciones ?? hit.cuartos;
  const habitaciones = rawHab !== undefined && rawHab !== null ? Number(rawHab) : undefined;

  const rawBanos = hit.bathrooms ?? hit.banos;
  const banos = rawBanos !== undefined && rawBanos !== null ? Number(rawBanos) : undefined;

  const rawPiso = hit.floor ?? hit.piso;
  const piso = rawPiso !== undefined && rawPiso !== null ? Number(rawPiso) : undefined;

  const barrioRaw = String(
    hit.neighborhood?.name ||
    hit.neighborhood ||
    hit.barrio ||
    hit.location?.neighborhood?.name ||
    ''
  );
  const barrio_normalizado = barrioRaw ? normalizarBarrio(barrioRaw) : undefined;

  const fecha_publicacion = hit.created_at || hit.publication_date || hit.fecha_publicacion || undefined;

  return {
    portal_origen: 'fincaraiz',
    id_anuncio_externo: id,
    url_anuncio: url,
    titulo,
    descripcion,
    precio_venta: precio,
    area_m2: area,
    valor_administracion: isNaN(valor_administracion!) ? undefined : valor_administracion,
    estrato: isNaN(estrato!) ? undefined : estrato,
    parqueaderos: isNaN(parqueaderos!) ? undefined : parqueaderos,
    tipo_parqueadero,
    habitaciones: isNaN(habitaciones!) ? undefined : habitaciones,
    banos: isNaN(banos!) ? undefined : banos,
    piso: isNaN(piso!) ? undefined : piso,
    localidad,
    barrio_normalizado,
    fecha_publicacion,
  };
}

export async function extraerFincaRaiz(config: ConfiguracionBusqueda): Promise<PropiedadEntrada[]> {
  try {
    const algoliaUrl = 'https://m1259m899p-dsn.algolia.net/1/indexes/fincaraiz_production_listings/query';

    const response = await fetch(algoliaUrl, {
      method: 'POST',
      headers: {
        'X-Algolia-API-Key': 'b7654a9ba14c442438cb20d44be80bc9',
        'X-Algolia-Application-Id': 'M1259M899P',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        params: 'query=Bogota&facetFilters=["offer_type:sale","property_type:apartment"]&hitsPerPage=50',
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.warn(`[Algolia FincaRaíz] Error en consulta Algolia (HTTP ${response.status}): ${errText.slice(0, 200)}`);
      return [];
    }

    const data: any = await response.json();
    const hits: any[] = data.hits || [];

    if (!Array.isArray(hits) || hits.length === 0) {
      console.warn('[Algolia FincaRaíz] La consulta a Algolia no devolvió ningún resultado.');
      return [];
    }

    return hits.map(parseAlgoliaHit).filter((item): item is PropiedadEntrada => item !== null);
  } catch (error) {
    console.error('[Algolia FincaRaíz] Error al consultar el motor de búsqueda Algolia:', error);
    return [];
  }
}

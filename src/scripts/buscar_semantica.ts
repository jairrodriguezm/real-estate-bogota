import { OpenAI } from 'openai';
import dotenv from 'dotenv';
import { supabase } from '../services/supabase.js';

dotenv.config();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

async function main() {
  try {
    const query = process.argv[2] || 'apartamento apto para remodelar o oportunidad de flipping en suba o usaquen';

    console.log(`[Búsqueda Semántica] Generando embedding para la consulta: "${query}"...`);

    const embeddingResponse = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: query,
    });

    const queryEmbedding = embeddingResponse.data[0].embedding;

    console.log('[Búsqueda Semántica] Ejecutando RPC buscar_propiedades_semantica en Supabase...');

    const { data: resultados, error } = await supabase.rpc('buscar_propiedades_semantica', {
      query_embedding: queryEmbedding,
      match_threshold: 0.3,
      match_count: 5,
    });

    if (error) {
      console.error('[Búsqueda Semántica] Error al consultar Supabase RPC:', error.message);
      process.exit(1);
    }

    if (!resultados || resultados.length === 0) {
      console.log('[Búsqueda Semántica] No se encontraron propiedades que coincidan con los criterios de búsqueda.');
      process.exit(0);
    }

    console.log(`\n🔍 Resultados de la búsqueda semántica (${resultados.length} coincidencias):\n`);
    console.log('='.repeat(80));

    resultados.forEach((item: any, index: number) => {
      const similarityScore = item.similarity !== undefined ? item.similarity : (item.similarity_score !== undefined ? item.similarity_score : 0);
      const similarityPercent = Math.round(similarityScore * 100);
      const precioM2 = item.precio_m2 ?? (item.area_m2 > 0 ? Math.round(item.precio_venta / item.area_m2) : 0);
      const barrio = item.barrio_normalizado ? ` / Barrio: ${item.barrio_normalizado}` : '';

      console.log(`\n#${index + 1} | Coincidencia: ${similarityPercent}%`);
      console.log(`   Título: ${item.titulo || 'Sin título'}`);
      console.log(`   Ubicación: Localidad ${item.localidad}${barrio}`);
      console.log(`   Área: ${item.area_m2} m²`);
      console.log(`   Precio: $${Number(item.precio_venta).toLocaleString('es-CO')} COP`);
      console.log(`   Precio/m²: $${Number(precioM2).toLocaleString('es-CO')} COP`);
      console.log(`   URL: ${item.url_anuncio || 'N/A'}`);
    });

    console.log('\n' + '='.repeat(80));
    process.exit(0);
  } catch (err: any) {
    console.error('[Búsqueda Semántica] Error inesperado:', err?.message || err);
    process.exit(1);
  }
}

main();

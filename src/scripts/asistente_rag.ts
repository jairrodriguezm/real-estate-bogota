import { OpenAI } from 'openai';
import dotenv from 'dotenv';
import { supabase } from '../services/supabase.js';

dotenv.config();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

async function main() {
  try {
    const userQuery =
      process.argv[2] ||
      'Busco apartamentos en Usaquén o Suba ideales para remodelar con presupuesto de hasta 300 millones';

    console.log(`[Asistente RAG] Generando embedding para la consulta: "${userQuery}"...`);

    const embeddingResponse = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: userQuery,
    });

    const queryEmbedding = embeddingResponse.data[0].embedding;

    console.log('[Asistente RAG] Consultando vector search en Supabase (RPC: buscar_propiedades_semantica)...');

    const { data: resultados, error } = await supabase.rpc('buscar_propiedades_semantica', {
      query_embedding: queryEmbedding,
      match_threshold: 0.3,
      match_count: 5,
    });

    if (error) {
      console.error('[Asistente RAG] Error al ejecutar RPC de Supabase:', error.message);
      process.exit(1);
    }

    if (!resultados || resultados.length === 0) {
      console.log('[Asistente RAG] No se encontraron propiedades relevantes en la base de datos para responder.');
      process.exit(0);
    }

    console.log(`[Asistente RAG] Se recuperaron ${resultados.length} propiedades contextualmente relevantes.`);

    const contextoInmuebles = resultados
      .map((item: any, index: number) => {
        const similarityScore =
          item.similarity !== undefined
            ? item.similarity
            : item.similarity_score !== undefined
            ? item.similarity_score
            : 0;
        const similarityPercent = Math.round(similarityScore * 100);
        const precioM2 = item.precio_m2 ?? (item.area_m2 > 0 ? Math.round(item.precio_venta / item.area_m2) : 0);
        const descSnippet = item.descripcion
          ? item.descripcion.length > 250
            ? item.descripcion.substring(0, 250) + '...'
            : item.descripcion
          : 'Sin descripción detallada';

        return `
--- INMUEBLE #${index + 1} ---
Similitud: ${similarityPercent}%
Título: ${item.titulo || 'Sin título'}
Ubicación: Localidad ${item.localidad}, barrio ${item.barrio_normalizado || 'no especificado'}, estrato ${item.estrato || 'N/A'}
Precio Venta: $${Number(item.precio_venta).toLocaleString('es-CO')} COP
Área: ${item.area_m2} m2 | Precio/m2: $${Number(precioM2).toLocaleString('es-CO')} COP
Habitaciones: ${item.habitaciones || 'N/A'}, Baños: ${item.banos || 'N/A'}
URL Anuncio: ${item.url_anuncio || 'N/A'}
Descripción Snippet: ${descSnippet}
`.trim();
      })
      .join('\n\n');

    console.log('[Asistente RAG] Generando análisis cuantitativo y cualitativo con GPT-4o-mini...');

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content:
            'Eres un analista experto en inversiones inmobiliarias y flipping de apartamentos en Bogotá. Analiza los inmuebles proporcionados en el contexto para responder la consulta del usuario. Sé directo, justifica cuál o cuáles tienen mejor potencial según su precio por m2, área y ubicación, y provee recomendaciones de inversión. Incluye el enlace de cada propiedad mencionada.',
        },
        {
          role: 'user',
          content: `Consulta del usuario: ${userQuery}\n\nContexto de inmuebles disponibles:\n\n${contextoInmuebles}`,
        },
      ],
      temperature: 0.3,
    });

    const respuestaLLM = completion.choices[0]?.message?.content || 'No se recibió respuesta del modelo.';

    console.log(`\n🤖 ANÁLISIS DEL ASISTENTE RAG (GPT-4o-mini):\n`);
    console.log('='.repeat(80));
    console.log(respuestaLLM);
    console.log('='.repeat(80) + '\n');

    process.exit(0);
  } catch (err: any) {
    console.error('[Asistente RAG] Error inesperado:', err?.message || err);
    process.exit(1);
  }
}

main();

import { OpenAI } from 'openai';
import dotenv from 'dotenv';
import { supabase } from '../services/supabase.js';

dotenv.config();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

async function main() {
  try {
    console.log('[Embeddings] Iniciando proceso de generación de embeddings...');

    const { data: propiedades, error } = await supabase
      .from('propiedades')
      .select('id, titulo, descripcion, localidad, barrio_normalizado, precio_venta, area_m2, habitaciones, banos, estrato')
      .is('embedding_descripcion', null);

    if (error) {
      console.error('[Embeddings] Error consultando propiedades:', error.message);
      process.exit(1);
    }

    if (!propiedades || propiedades.length === 0) {
      console.log('[Embeddings] No hay propiedades pendientes por generar embeddings.');
      process.exit(0);
    }

    const total = propiedades.length;
    console.log(`[Embeddings] Se encontraron ${total} propiedades sin embedding.`);

    const BATCH_SIZE = 20;
    let procesadas = 0;

    for (let i = 0; i < total; i += BATCH_SIZE) {
      const batch = propiedades.slice(i, i + BATCH_SIZE);
      const batchTextos = batch.map((p) =>
        `
  Título: ${p.titulo || 'Apartamento en venta'}
  Ubicación: ${p.localidad}, barrio ${p.barrio_normalizado || 'no especificado'}, estrato ${p.estrato || 'N/A'}.
  Características: ${p.area_m2} m2, ${p.habitaciones || 'N/A'} habitaciones, ${p.banos || 'N/A'} baños.
  Precio: $${p.precio_venta} COP.
  Descripción: ${p.descripcion || 'Sin descripción detallada'}.
        `.trim()
      );

      const response = await openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: batchTextos,
      });

      for (let j = 0; j < batch.length; j++) {
        const p = batch[j];
        const embeddingData = response.data[j];
        if (embeddingData) {
          const { error: updateError } = await supabase
            .from('propiedades')
            .update({ embedding_descripcion: embeddingData.embedding })
            .eq('id', p.id);

          if (updateError) {
            console.error(`[Embeddings] Error actualizando propiedad ${p.id}:`, updateError.message);
          }
        }
      }

      procesadas += batch.length;
      console.log(`[Embeddings] Procesadas ${procesadas}/${total} propiedades...`);
    }

    console.log('[Embeddings] Proceso completado exitosamente.');
    process.exit(0);
  } catch (err: any) {
    console.error('[Embeddings] Error inesperado en el script:', err?.message || err);
    process.exit(1);
  }
}

main();

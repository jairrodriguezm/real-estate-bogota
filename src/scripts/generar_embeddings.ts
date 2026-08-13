import { OpenAI } from 'openai';
import dotenv from 'dotenv';
import { supabase } from '../services/supabase.js';

dotenv.config();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

async function main() {
  try {
    console.log('[Embeddings] Iniciando generación de embeddings enriquecidos para inmuebles activos...');

    const { data: propiedades, error } = await supabase
      .from('propiedades')
      .select('id, titulo, barrio_normalizado, localidad, precio_venta, area_m2, habitaciones, banos, estrato, antiguedad, valor_administracion, ascensor, conjunto_cerrado, descripcion')
      .eq('activo', true)
      .or('embedding_descripcion.is.null');

    if (error) {
      console.error('[Embeddings] Error consultando propiedades en Supabase:', error.message);
      process.exit(1);
    }

    if (!propiedades || propiedades.length === 0) {
      console.log('[Embeddings] No hay propiedades activas pendientes por generar embeddings.');
      process.exit(0);
    }

    const total = propiedades.length;
    console.log(`[Embeddings] Se encontraron ${total} propiedades activas para procesar.`);

    for (let index = 0; index < total; index++) {
      const p = propiedades[index];

      const textoParaEmbedding = `
  Título: ${p.titulo || ''}
  Barrio: ${p.barrio_normalizado || ''}
  Localidad: ${p.localidad || ''}
  Precio Venta: $${p.precio_venta ? p.precio_venta.toLocaleString() : 'N/A'} COP
  Área: ${p.area_m2 || 'N/A'} m2
  Habitaciones: ${p.habitaciones || 'N/A'}
  Baños: ${p.banos || 'N/A'}
  Estrato: ${p.estrato || 'N/A'}
  Antigüedad: ${p.antiguedad || 'N/A'}
  Administración: $${p.valor_administracion ? p.valor_administracion.toLocaleString() : 'N/A'} COP
  Ascensor: ${p.ascensor ? 'Sí' : 'No'}
  Conjunto Cerrado: ${p.conjunto_cerrado ? 'Sí' : 'No'}
  Descripción: ${p.descripcion || ''}
      `.trim();

      try {
        const response = await openai.embeddings.create({
          model: 'text-embedding-3-small',
          input: textoParaEmbedding,
        });

        const embeddingVector = response.data[0]?.embedding;

        if (embeddingVector) {
          const { error: updateError } = await supabase
            .from('propiedades')
            .update({ embedding_descripcion: embeddingVector })
            .eq('id', p.id);

          if (updateError) {
            console.error(`[Embeddings] Error actualizando vector para ID ${p.id}:`, updateError.message);
          } else {
            console.log(`[Embeddings] [${index + 1}/${total}] Vector generado para ID: ${p.id}.`);
          }
        }
      } catch (apiErr: any) {
        console.error(`[Embeddings Error] Falló API de OpenAI para ID ${p.id}:`, apiErr?.message || apiErr);
      }

      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    console.log('[Embeddings] Proceso completado exitosamente.');
    process.exit(0);
  } catch (err: any) {
    console.error('[Embeddings] Error inesperado en el script:', err?.message || err);
    process.exit(1);
  }
}

main();

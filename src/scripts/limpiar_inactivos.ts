import dotenv from 'dotenv';
import { supabase } from '../services/supabase.js';

dotenv.config();

async function main() {
  console.log('[Limpieza] Iniciando consulta de apartamentos inactivos (activo: false)...');

  try {
    const { count: totalInactivos, error: countError } = await supabase
      .from('propiedades')
      .select('*', { count: 'exact', head: true })
      .eq('activo', false);

    if (countError) {
      console.error('[Limpieza Error] Error consultando conteo de inactivos:', countError.message);
      process.exit(1);
    }

    if (!totalInactivos || totalInactivos === 0) {
      console.log('[Limpieza] No se encontraron apartamentos inactivos para eliminar.');
      process.exit(0);
    }

    console.log(`[Limpieza] Encontrados ${totalInactivos} apartamentos inactivos. Eliminando registros...`);

    const { data, error } = await supabase
      .from('propiedades')
      .delete()
      .eq('activo', false)
      .select('id, id_anuncio_externo');

    if (error) {
      console.error('[Limpieza Error] Error al eliminar apartamentos inactivos:', error.message);
      process.exit(1);
    }

    console.log(`[Limpieza] Se eliminaron exitosamente ${data?.length || 0} apartamentos inactivos de la base de datos.`);
  } catch (err: any) {
    console.error('[Limpieza Error] Error fatal durante el proceso de limpieza:', err?.message || err);
    process.exit(1);
  }

  process.exit(0);
}

main();

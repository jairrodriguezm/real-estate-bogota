import 'dotenv/config';
import { obtenerConfiguracionActiva, procesarInmueble } from './services/supabase.js';
import { extraerCienCuadras } from './scrapers/ciencuadras.js';

async function main(): Promise<void> {
  const inicioTiempo = Date.now();
  console.log('🚀 Iniciando pipeline de scraping y procesamiento de inmuebles...');

  try {
    // 1. Load active search configuration
    console.log('🔍 Cargando configuración activa de búsqueda...');
    const config = await obtenerConfiguracionActiva();
    console.log(`✅ Configuración cargada correctamente: "${config.nombre_perfil}" (ID: ${config.id})`);

    // 2. Call CienCuadras scraper
    console.log('📥 Obteniendo publicaciones de CienCuadras...');
    const inmuebles = await extraerCienCuadras(config);
    const totalExtraidos = inmuebles.length;
    console.log(`📊 Total de inmuebles extraídos de CienCuadras: ${totalExtraidos}`);

    // 3. Iterate over items and process sequentially using procesarInmueble
    let procesados = 0;
    for (const item of inmuebles) {
      await procesarInmueble(item, config);
      procesados++;
    }

    // 4. Calculate execution time and log summary
    const finTiempo = Date.now();
    const duracionSegundos = ((finTiempo - inicioTiempo) / 1000).toFixed(2);

    console.log('\n====================================');
    console.log('📌 RESUMEN DE EJECUCIÓN DEL SCRAPER');
    console.log('====================================');
    console.log(`- Total extraídos de CienCuadras: ${totalExtraidos}`);
    console.log(`- Total de inmuebles procesados: ${procesados}`);
    console.log(`- Tiempo total de ejecución: ${duracionSegundos}s`);
    console.log('====================================\n');
    console.log('[Scraper] Búsqueda y guardado base completados con éxito. Para enriquecer detalles profundos ejecute: npm run enriquecer');
  } catch (error) {
    console.error('❌ Error crítico en el pipeline:', error);
    process.exit(1);
  }
}

main();

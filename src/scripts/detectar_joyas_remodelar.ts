import 'dotenv/config';
import { supabase } from '../services/supabase.js';

const COSTO_REMODELACION_M2 = 750000;

interface JoyaRemodelar {
  id: string;
  barrio: string;
  precio_compra: number;
  area_m2: number;
  costo_obra: number;
  gastos_cierre: number;
  inversion_total: number;
  venta_proyectada: number;
  utilidad_estimada: number;
  roi_pct: number;
  ascensor: boolean;
  bonus_score: number;
  antiguedad: string;
  url: string;
}

function esAntiguedadApta(antiguedad?: string | null): boolean {
  if (!antiguedad) return false;
  const norm = antiguedad.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  if (
    norm.includes('16 a 30') ||
    norm.includes('mas de 20') ||
    norm.includes('mas de 30') ||
    norm.includes('10 a 20') ||
    norm.includes('20+') ||
    norm.includes('remodelar') ||
    norm.includes('viejo') ||
    norm.includes('antiguo')
  ) {
    return true;
  }

  const numMatch = norm.match(/(\d+)\s*(?:anios|años|anos)?/);
  if (numMatch) {
    const years = parseInt(numMatch[1], 10);
    if (!isNaN(years) && years >= 15) {
      return true;
    }
  }

  return false;
}

function tieneParqueadero(p: any): boolean {
  if (p.parqueaderos && p.parqueaderos >= 1) return true;

  const fullText = `${p.titulo || ''} ${p.url_anuncio || ''} ${p.descripcion || ''}`.toLowerCase();
  return (
    fullText.includes('parqueadero') ||
    fullText.includes('garaje') ||
    fullText.includes('1par') ||
    fullText.includes('2par') ||
    fullText.includes('3par')
  );
}

function calcularBonusScore(descripcion?: string | null): number {
  if (!descripcion) return 0;
  const desc = descripcion.toLowerCase();
  const keywords = ['remodelar', 'para remodelar', 'original', 'buenos espacios', 'amplio', 'oportunidad'];
  let score = 0;
  for (const kw of keywords) {
    if (desc.includes(kw)) {
      score += 1;
    }
  }
  return score;
}

function formatCOP(valor: number): string {
  return new Intl.NumberFormat('es-CO', {
    style: 'currency',
    currency: 'COP',
    maximumFractionDigits: 0,
  }).format(valor);
}

async function main(): Promise<void> {
  console.log('💎 Iniciando detector de "Joyas para Remodelar" (Value-Add / Flipping)...');

  // 1. Fetch active properties from Supabase
  const { data: propiedades, error } = await supabase
    .from('propiedades')
    .select('*')
    .eq('activo', true);

  if (error) {
    console.error('❌ Error consultando propiedades en Supabase:', error.message);
    process.exit(1);
  }

  if (!propiedades || propiedades.length === 0) {
    console.log('⚠️ No se encontraron propiedades activas en la base de datos.');
    return;
  }

  console.log(`📊 Inmuebles activos consultados: ${propiedades.length}`);

  // Calculate median precio_m2 for neighborhoods with >= 3 listings
  const barrioMap = new Map<string, number[]>();

  for (const p of propiedades) {
    if (!p.barrio_normalizado || !p.precio_venta || !p.area_m2 || p.area_m2 <= 0) continue;
    const pm2 = p.precio_m2 && p.precio_m2 > 0 ? p.precio_m2 : p.precio_venta / p.area_m2;

    if (!barrioMap.has(p.barrio_normalizado)) {
      barrioMap.set(p.barrio_normalizado, []);
    }
    barrioMap.get(p.barrio_normalizado)!.push(pm2);
  }

  const barrioMediana = new Map<string, number>();
  for (const [barrio, precios] of barrioMap.entries()) {
    if (precios.length >= 3) {
      const sorted = [...precios].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      const median = sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
      barrioMediana.set(barrio, median);
    }
  }

  console.log(`🏘️ Barrios con suficiente muestra (>= 3 inmuebles): ${barrioMediana.size}`);

  // 2 & 3. Filter candidates and perform financial calculations
  const candidatas: JoyaRemodelar[] = [];

  for (const p of propiedades) {
    if (!p.barrio_normalizado || !p.precio_venta || !p.area_m2) continue;

    // Filter: Area >= 55 m2
    if (p.area_m2 < 55) continue;

    // Filter: Parking space >= 1 (or confirmed in text/url)
    if (!tieneParqueadero(p)) continue;

    // Filter: Antigüedad apta (>= 15 years or key aging strings)
    if (!esAntiguedadApta(p.antiguedad)) continue;

    // Filter: Neighborhood median check and >= 15% discount
    const medianaBarrio = barrioMediana.get(p.barrio_normalizado);
    if (!medianaBarrio) continue;

    const pm2 = p.precio_m2 && p.precio_m2 > 0 ? p.precio_m2 : p.precio_venta / p.area_m2;
    const descuentoPct = ((medianaBarrio - pm2) / medianaBarrio) * 100;
    if (descuentoPct < 15) continue;

    // Financial calculations
    const costo_obra = p.area_m2 * COSTO_REMODELACION_M2;
    const gastos_cierre = p.precio_venta * 0.04;
    const inversion_total = p.precio_venta + costo_obra + gastos_cierre;
    const venta_proyectada = p.area_m2 * medianaBarrio * 1.05;
    const utilidad_estimada = venta_proyectada - inversion_total;
    const roi_pct = (utilidad_estimada / inversion_total) * 100;

    // Only consider opportunities with positive ROI
    if (roi_pct <= 0) continue;

    const bonus_score = calcularBonusScore(p.descripcion);

    candidatas.push({
      id: p.id,
      barrio: p.barrio_normalizado,
      precio_compra: p.precio_venta,
      area_m2: p.area_m2,
      costo_obra,
      gastos_cierre,
      inversion_total,
      venta_proyectada,
      utilidad_estimada,
      roi_pct,
      ascensor: Boolean(p.ascensor),
      bonus_score,
      antiguedad: p.antiguedad || 'N/A',
      url: p.url_anuncio,
    });
  }

  // 4. Sort by ROI % descending (secondary sort by bonus_score descending)
  candidatas.sort((a, b) => {
    if (b.roi_pct !== a.roi_pct) return b.roi_pct - a.roi_pct;
    return b.bonus_score - a.bonus_score;
  });

  const top15 = candidatas.slice(0, 15);

  console.log('\n========================================================================================');
  console.log(`🏆 TOP ${top15.length} JOYAS PARA REMODELAR (Oportunidades de Flipping Encontradas: ${candidatas.length})`);
  console.log('========================================================================================\n');

  if (top15.length > 0) {
    const tableData = top15.map((c) => ({
      'Barrio': c.barrio,
      'Precio Compra': formatCOP(c.precio_compra),
      'Area m2': `${c.area_m2} m²`,
      'Costo Obra': formatCOP(c.costo_obra),
      'Inversión Total': formatCOP(c.inversion_total),
      'Venta Proyectada': formatCOP(c.venta_proyectada),
      'Utilidad Estimada': formatCOP(c.utilidad_estimada),
      'ROI %': `${c.roi_pct.toFixed(1)}%`,
      'Ascensor': c.ascensor ? 'Sí' : 'No',
      'URL': c.url,
    }));

    console.table(tableData);
  } else {
    console.log('ℹ️ No se encontraron inmuebles que cumplan con todos los criterios de "Joyas para Remodelar".');
  }

  console.log('\n📌 Resumen:');
  console.log(`- Total de inmuebles analizados: ${propiedades.length}`);
  console.log(`- Oportunidades de Flipping / Value-Add identificadas: ${candidatas.length}`);
  console.log('========================================================================================\n');
}

main();

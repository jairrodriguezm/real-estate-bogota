import { LocalidadBogota } from '../types/index.js';

export const barriosKennedy = [
  'castilla',
  'mandalay',
  'marsella',
  'timiza',
  'tintal',
  'el tintal',
  'americas occidental',
  'bavaria',
  'carvajal',
  'kennedy central',
  'villa alsacia',
  'valladolid',
  'pastrana',
  'roma',
  'techo',
  'nueva marsella',
  'provivienda'
];

export function normalizarLocalidad(texto: string): LocalidadBogota | null {
  if (!texto) return null;
  const t = texto.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  if (t.includes('usaquen')) return 'Usaquén';
  if (t.includes('suba')) return 'Suba';
  if (t.includes('barrios unidos')) return 'Barrios Unidos';
  if (t.includes('chapinero')) return 'Chapinero';
  if (t.includes('teusaquillo')) return 'Teusaquillo';
  if (t.includes('kennedy')) return 'Kennedy';

  for (const barrio of barriosKennedy) {
    const barrioNorm = barrio.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (t.includes(barrioNorm)) {
      return 'Kennedy';
    }
  }

  return null;
}

export function normalizarBarrio(texto: string): string {
  if (!texto) return '';
  return texto
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ');
}

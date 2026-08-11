import { LocalidadBogota } from '../types/index.js';

export function normalizarLocalidad(texto: string): LocalidadBogota | null {
  if (!texto) return null;
  const t = texto.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  if (t.includes('usaquen')) return 'Usaquén';
  if (t.includes('suba')) return 'Suba';
  if (t.includes('barrios unidos')) return 'Barrios Unidos';
  if (t.includes('chapinero')) return 'Chapinero';
  if (t.includes('teusaquillo')) return 'Teusaquillo';

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

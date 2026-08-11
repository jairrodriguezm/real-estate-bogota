import dotenv from 'dotenv';
import { PropiedadEntrada } from '../types/index.js';

dotenv.config();

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

function formatCOP(valor?: number): string {
  if (valor === undefined || valor === null) return 'N/A';
  return new Intl.NumberFormat('es-CO', {
    style: 'currency',
    currency: 'COP',
    maximumFractionDigits: 0,
  }).format(valor);
}

async function sendTelegramMessage(text: string): Promise<void> {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn('[Telegram] Faltan variables de entorno TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID');
    return;
  }

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: 'Markdown',
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[Telegram] Error al enviar mensaje (${response.status}):`, errorText);
    }
  } catch (error) {
    console.error('[Telegram] Error de red al enviar mensaje:', error);
  }
}

export async function notificarOportunidad(
  prop: PropiedadEntrada,
  descuento: number,
  promedioZona: number
): Promise<void> {
  const precioM2 = prop.area_m2 > 0 ? prop.precio_venta / prop.area_m2 : 0;
  const titulo = prop.titulo || `Inmueble en ${prop.localidad}`;
  const barrio = prop.barrio_normalizado || prop.localidad;
  const parqueaderosInfo = prop.parqueaderos !== undefined
    ? `${prop.parqueaderos}${prop.tipo_parqueadero ? ` (${prop.tipo_parqueadero})` : ''}`
    : 'No especificado';
  const adminInfo = prop.valor_administracion !== undefined ? formatCOP(prop.valor_administracion) : 'No especificado';

  const mensaje = [
    `🚨 *¡OPORTUNIDAD DE INVERSIÓN!* 🚨`,
    ``,
    `📌 *Título:* ${titulo}`,
    `📍 *Barrio / Sector:* ${barrio} (${prop.localidad})`,
    `💰 *Precio de Venta:* ${formatCOP(prop.precio_venta)}`,
    `📐 *Área:* ${prop.area_m2} m²`,
    `📊 *Precio/m²:* ${formatCOP(precioM2)}/m²`,
    `📉 *Promedio Zona:* ${formatCOP(promedioZona)}/m² (Descuento: *${descuento.toFixed(1)}%*)`,
    `🚗 *Parqueaderos:* ${parqueaderosInfo}`,
    `🏢 *Administración:* ${adminInfo}`,
    ``,
    `🔗 [Ver Anuncio en ${prop.portal_origen}](${prop.url_anuncio})`,
  ].join('\n');

  await sendTelegramMessage(mensaje);
}

export async function notificarBajaPrecio(
  prop: PropiedadEntrada,
  precioAnterior: number,
  porcentajeBaja: number
): Promise<void> {
  const titulo = prop.titulo || `Inmueble en ${prop.localidad}`;
  const barrio = prop.barrio_normalizado || prop.localidad;

  const mensaje = [
    `📉 *¡REDUCCIÓN DE PRECIO DETECTADA!* 📉`,
    ``,
    `📌 *Título:* ${titulo}`,
    `📍 *Ubicación:* ${barrio} (${prop.localidad})`,
    `🏷️ *Precio Anterior:* ~${formatCOP(precioAnterior)}~`,
    `💰 *Precio Nuevo:* *${formatCOP(prop.precio_venta)}*`,
    `💥 *Reducción:* *${Math.abs(porcentajeBaja).toFixed(1)}%* de descuento`,
    ``,
    `🔗 [Ver Anuncio en ${prop.portal_origen}](${prop.url_anuncio})`,
  ].join('\n');

  await sendTelegramMessage(mensaje);
}

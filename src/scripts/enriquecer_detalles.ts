import { chromium, BrowserContext, Page } from 'playwright';
import dotenv from 'dotenv';
import { supabase } from '../services/supabase.js';

dotenv.config();

const BATCH_SIZE = 20;
const CONCURRENCY = 3;

async function procesarPropiedad(
  context: BrowserContext,
  item: { id: string; id_anuncio_externo: string; url_anuncio: string },
  itemIndex: number,
  totalItems: number
): Promise<boolean> {
  let page: Page | null = null;
  try {
    page = await context.newPage();

    // 1. Route Interception to Block Heavy Assets & Trackers
    await page.route('**/*', (route) => {
      const resourceType = route.request().resourceType();
      const url = route.request().url();
      if (
        ['image', 'media', 'font', 'stylesheet'].includes(resourceType) ||
        url.includes('google-analytics') ||
        url.includes('facebook') ||
        url.includes('hotjar') ||
        url.includes('doubleclick')
      ) {
        return route.abort();
      }
      return route.continue();
    });

    // Gentle random delay per worker (1000ms - 2000ms) to avoid rate-limiting while maintaining high throughput
    const delay = Math.floor(Math.random() * 1000) + 1000;
    await page.waitForTimeout(delay);

    // 2. Fast Page Navigation (domcontentloaded with 20s timeout)
    const response = await page.goto(item.url_anuncio, {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
    });

    const status = response?.status();
    const bodyText = (await page.textContent('body')) || '';
    const bodyTextLower = bodyText.toLowerCase();

    // Cloudflare / WAF Detection
    if (
      bodyText.includes('Error 1015') ||
      bodyText.includes('rate limited') ||
      bodyText.includes('You are being rate limited') ||
      status === 429 ||
      status === 403 ||
      bodyTextLower.includes('access denied') ||
      bodyTextLower.includes('just a moment')
    ) {
      console.warn(`[WAF/RateLimit] Bloqueo detectado en URL ${item.url_anuncio}.`);
      return false;
    }

    // Inactivity Detection (mark active = false)
    const isInactive =
      bodyTextLower.includes('este inmueble ya no está disponible') ||
      bodyTextLower.includes('inmueble no disponible') ||
      bodyTextLower.includes('anuncio finalizado');

    if (isInactive) {
      console.log(
        `[Enriquecer] Propiedad ${item.id_anuncio_externo || item.id} marcando como NO DISPONIBLE (activo: false).`
      );
      await supabase
        .from('propiedades')
        .update({ activo: false })
        .eq('id', item.id);
      return false;
    }

    // Brief wait for detail nodes (strong tags)
    await page.waitForSelector('strong', { timeout: 2500 }).catch(() => {});

    // DOM Evaluation for property details
    const datosDOM = await page.evaluate(() => {
      const result = {
        antiguedad: 'N/A',
        estrato: null as number | null,
        valor_administracion: null as number | null,
        ascensor: false,
      };

      const strongElements = Array.from(document.querySelectorAll('strong'));

      for (const strong of strongElements) {
        const labelText = (strong.textContent || '')
          .toLowerCase()
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '');

        if (labelText.includes('antiguedad')) {
          const parentSpan = strong.closest('span') || strong.parentElement;
          if (parentSpan) {
            const cleanVal =
              parentSpan.textContent
                ?.replace(/antig[üu]edad\s*:?/i, '')
                .replace(/\u00a0/g, ' ')
                .trim() || '';
            if (cleanVal.length > 0 && cleanVal.length < 50) {
              result.antiguedad = cleanVal;
            }
          }
        }

        if (labelText.includes('estrato')) {
          const parentSpan = strong.closest('span') || strong.parentElement;
          if (parentSpan) {
            const cleanVal = parentSpan.textContent?.replace(/estrato\s*:?/i, '').trim() || '';
            const num = parseInt(cleanVal, 10);
            if (!isNaN(num)) result.estrato = num;
          }
        }

        if (labelText.includes('administracion')) {
          const parentSpan = strong.closest('span') || strong.parentElement;
          if (parentSpan) {
            const fullText = parentSpan.textContent || '';
            const cleanDigits = fullText.replace(/administraci[oó]n\s*:?/i, '').replace(/\D/g, '');
            if (cleanDigits.length > 0) {
              const parsedVal = parseInt(cleanDigits, 10);
              if (!isNaN(parsedVal)) result.valor_administracion = parsedVal;
            }
          }
        }
      }

      if (result.valor_administracion === null) {
        const bodyText = document.body.innerText || '';
        const matchAdmin = bodyText.match(/administraci[oó]n\s*:?\s*\$?\s*([\d\.,]+)/i);
        if (matchAdmin && matchAdmin[1]) {
          const digits = matchAdmin[1].replace(/\D/g, '');
          const parsed = parseInt(digits, 10);
          if (!isNaN(parsed)) result.valor_administracion = parsed;
        }
      }

      if (result.antiguedad === 'N/A') {
        const bodyText = document.body.innerText || '';
        const match = bodyText.match(
          /antig[üu]edad\s*:?\s*(\d+\s+años?|\d+\s+a\s+\d+\s+años?|más\s+de\s+\d+\s+años|en\s+construcción|sobre\s+planos|a\s+estrenar)/i
        );
        if (match && match[1]) {
          result.antiguedad = match[1].trim();
        }
      }

      const bodyText = document.body.innerText || '';
      const ascensorMatch = bodyText.match(/ascensores?\s*:?\s*(\d+)/i);
      if (ascensorMatch) {
        result.ascensor = parseInt(ascensorMatch[1], 10) > 0;
      } else {
        result.ascensor =
          bodyText.toLowerCase().includes('con ascensor') ||
          bodyText.toLowerCase().includes('posee ascensor');
      }

      return result;
    });

    const antiguedadLimpia = datosDOM.antiguedad || 'N/A';
    const estrato = datosDOM.estrato;
    const ascensor = datosDOM.ascensor;
    const valor_administracion = datosDOM.valor_administracion;

    const descripcionLimpia = await page.evaluate(() => {
      const scripts = Array.from(document.querySelectorAll('script'));
      for (const script of scripts) {
        const content = script.textContent || '';
        if (content.includes('&q;description&q;:')) {
          const match = content.match(/&q;description&q;:&q;(.*?)&q;/);
          if (match && match[1]) {
            const jsonDesc = match[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').trim();
            if (jsonDesc.length > 20 && !jsonDesc.includes('Soy MIA')) {
              return jsonDesc;
            }
          }
        }
      }

      const descSelectors = [
        '.description-content',
        '[class*="description-text"]',
        '#description',
        '.description',
      ];

      for (const sel of descSelectors) {
        const el = document.querySelector(sel);
        if (el && el.textContent) {
          const text = el.textContent.trim();
          if (text.length > 20 && !text.includes('Soy MIA') && !text.includes('asistente')) {
            return text;
          }
        }
      }

      return '';
    });

    let descripcionFinal = (descripcionLimpia || '').trim();
    if (descripcionFinal.includes('Soy MIA')) {
      descripcionFinal = descripcionFinal.split('👋🏻')[0].split('Soy MIA')[0].trim();
    }
    if (descripcionFinal.includes('{&q;') || descripcionFinal.includes('<style>')) {
      descripcionFinal = descripcionFinal.split('{&q;')[0].split('<style>')[0].trim();
    }

    const deposito =
      bodyTextLower.includes('depósito') ||
      bodyTextLower.includes('deposito') ||
      bodyTextLower.includes('bodega');
    const conjunto_cerrado = bodyTextLower.includes('conjunto cerrado');

    // 4. Immediate Save in Supabase per Item
    const { error: updateError } = await supabase
      .from('propiedades')
      .update({
        descripcion: descripcionFinal,
        deposito,
        ascensor,
        antiguedad: antiguedadLimpia,
        estrato,
        valor_administracion,
        conjunto_cerrado,
        activo: true,
      })
      .eq('id', item.id);

    if (updateError) {
      console.error(`[Enriquecer] [Error DB] ID ${item.id}:`, updateError.message);
      return false;
    }

    console.log(
      `[Progress ${itemIndex + 1}/${totalItems}] ${item.id_anuncio_externo} -> Age: ${antiguedadLimpia} | Admin: $${valor_administracion ?? 0} | Lift: ${ascensor}`
    );
    return true;
  } catch (err: any) {
    console.error(`[Error Ítem ${itemIndex + 1}] Falló en URL ${item.url_anuncio}:`, err?.message || err);
    return false;
  } finally {
    if (page) {
      await page.close().catch(() => {});
    }
  }
}

async function main() {
  console.log(`⚡ [Enriquecer] Iniciando proceso optimizado con concurrencia (${CONCURRENCY} workers)...`);
  let totalProcesados = 0;
  let batchNum = 0;

  try {
    while (true) {
      batchNum++;
      console.log(`\n[Enriquecer] [Lote #${batchNum}] Consultando hasta ${BATCH_SIZE} inmuebles pendientes ACTIVOS...`);

      const { data: pendientes, error } = await supabase
        .from('propiedades')
        .select('id, id_anuncio_externo, url_anuncio')
        .eq('activo', true)
        .or('descripcion.is.null,descripcion.eq.""')
        .limit(BATCH_SIZE);

      if (error) {
        console.error('[Enriquecer] Error consultando Supabase:', error.message);
        break;
      }

      if (!pendientes || pendientes.length === 0) {
        console.log('[Enriquecer] Todos los inmuebles ACTIVOS han sido enriquecidos con éxito.');
        break;
      }

      console.log(`[Enriquecer] [Lote #${batchNum}] Procesando ${pendientes.length} inmuebles con concurrencia = ${CONCURRENCY}...`);

      const isHeadless = process.env.HEADLESS !== 'false';

      const browser = await chromium.launch({
        headless: isHeadless,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
        ],
      });

      const context = await browser.newContext({
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        viewport: { width: 1366, height: 768 },
        locale: 'es-CO',
        timezoneId: 'America/Bogota',
      });

      await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      });

      // 3. Worker Pool Concurrency (CONCURRENCY = 3)
      for (let i = 0; i < pendientes.length; i += CONCURRENCY) {
        const chunk = pendientes.slice(i, i + CONCURRENCY);
        const results = await Promise.all(
          chunk.map((item, idx) => procesarPropiedad(context, item, i + idx, pendientes.length))
        );
        totalProcesados += results.filter(Boolean).length;
      }

      await browser.close().catch(() => {});
      console.log(`[Enriquecer] [Lote #${batchNum}] Lote finalizado. Navegador cerrado. Pausando 15s antes del siguiente lote...`);
      await new Promise((resolve) => setTimeout(resolve, 15000));
    }

    console.log(`\n[Enriquecer] Proceso finalizado con éxito. Total acumulado enriquecido: ${totalProcesados} inmuebles.`);
  } catch (err: any) {
    console.error('[Enriquecer] Error fatal en la ejecución por lotes:', err?.message || err);
    process.exit(1);
  }

  process.exit(0);
}

main();

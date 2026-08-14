import { chromium, Page } from 'playwright';
import dotenv from 'dotenv';
import { supabase } from '../services/supabase.js';

dotenv.config();

const BATCH_SIZE = 20;

async function main() {
  console.log('[Enriquecer] Iniciando proceso de enriquecimiento por lotes de 20 propiedades con evasión de Cloudflare 1015...');
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

      console.log(`[Enriquecer] [Lote #${batchNum}] Procesando ${pendientes.length} inmuebles ACTIVOS...`);

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

      // Ocultar la bandera navigator.webdriver para mitigar detección anti-bot
      await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      });

      for (let index = 0; index < pendientes.length; index++) {
        const item = pendientes[index];
        let page: Page | null = null;
        let attempt = 0;
        const maxAttempts = 2;

        while (attempt < maxAttempts) {
          attempt++;
          try {
            page = await context.newPage();

            // 1. Low-frequency Human Delays (5000ms - 9000ms)
            const delay = Math.floor(Math.random() * 4000) + 5000;
            console.log(`[Rate-Limit Guard] Esperando ${Math.round(delay / 1000)}s antes del siguiente ítem...`);
            await page.waitForTimeout(delay);

            const response = await page.goto(item.url_anuncio, {
              waitUntil: 'domcontentloaded',
              timeout: 12000,
            });

            const status = response?.status();
            await page.waitForTimeout(2000);

            const bodyText = (await page.textContent('body')) || '';
            const bodyTextLower = bodyText.toLowerCase();

            // 2. Cloudflare Error 1015 Interceptor & Auto-Pause (3 minutos)
            if (
              bodyText.includes('Error 1015') ||
              bodyText.includes('rate limited') ||
              bodyText.includes('You are being rate limited') ||
              status === 429
            ) {
              console.warn(
                '[Cloudflare 1015] Bloqueo de tasa detectado. Pausando el scraper durante 3 minutos para enfriar la IP...'
              );
              await page.close().catch(() => {});
              page = null;
              await new Promise((resolve) => setTimeout(resolve, 180000)); // Pause for 3 minutes
              throw new Error('Cloudflare 1015 Rate Limit hit');
            }

            // Detección general de WAF / 403 / Cloudflare
            const isWAFBlocked =
              status === 403 ||
              bodyTextLower.includes('cloudflare') ||
              bodyTextLower.includes('access denied') ||
              bodyTextLower.includes('just a moment');

            if (isWAFBlocked) {
              console.warn(
                `[WAF Warning] Bloqueo detectado en URL ${item.url_anuncio}. Pausando ejecución por 30 segundos...`
              );
              await page.close().catch(() => {});
              page = null;
              await new Promise((r) => setTimeout(r, 30000));

              if (attempt < maxAttempts) {
                console.log(
                  `[WAF Retry] Reintentando propiedad ${item.id_anuncio_externo || item.id} (intento ${attempt + 1})...`
                );
                continue;
              } else {
                break;
              }
            }

            // 1. Detección de Inactividad (marcar activo: false)
            const isInactive =
              bodyTextLower.includes('este inmueble ya no está disponible') ||
              bodyTextLower.includes('inmueble no disponible') ||
              bodyTextLower.includes('anuncio finalizado');

            if (isInactive) {
              console.log(
                `[Enriquecer] Propiedad ${item.id_anuncio_externo || item.id} marcando como NO DISPONIBLE (activo: false).`
              );
              const { error: inactiveError } = await supabase
                .from('propiedades')
                .update({ activo: false })
                .eq('id', item.id);

              if (inactiveError) {
                console.error(`[Enriquecer] [Error DB Inactivo] ID ${item.id}:`, inactiveError.message);
              }
              break;
            }

            // Wait up to 3500ms for detail lists / Angular strong tags to be populated
            await page.waitForSelector('strong', { timeout: 3500 }).catch(() => {});

            // 2. Direct Text-Node DOM Traversal (Antigüedad, Estrato, Administración, Ascensor)
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

                // Extract Antigüedad
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

                // Extract Estrato
                if (labelText.includes('estrato')) {
                  const parentSpan = strong.closest('span') || strong.parentElement;
                  if (parentSpan) {
                    const cleanVal = parentSpan.textContent?.replace(/estrato\s*:?/i, '').trim() || '';
                    const num = parseInt(cleanVal, 10);
                    if (!isNaN(num)) result.estrato = num;
                  }
                }

                // Extract Administración
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

              // Global Regex Fallback for Administración if missing in strong loop
              if (result.valor_administracion === null) {
                const bodyText = document.body.innerText || '';
                const matchAdmin = bodyText.match(/administraci[oó]n\s*:?\s*\$?\s*([\d\.,]+)/i);
                if (matchAdmin && matchAdmin[1]) {
                  const digits = matchAdmin[1].replace(/\D/g, '');
                  const parsed = parseInt(digits, 10);
                  if (!isNaN(parsed)) result.valor_administracion = parsed;
                }
              }

              // Global Regex Fallback for Antigüedad if missing in strong loop
              if (result.antiguedad === 'N/A') {
                const bodyText = document.body.innerText || '';
                const match = bodyText.match(
                  /antig[üu]edad\s*:?\s*(\d+\s+años?|\d+\s+a\s+\d+\s+años?|más\s+de\s+\d+\s+años|en\s+construcción|sobre\s+planos|a\s+estrenar)/i
                );
                if (match && match[1]) {
                  result.antiguedad = match[1].trim();
                }
              }

              // Parse Ascensor
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

            // 3. Extracción filtrada de descripción (excluyendo chatbot MIA)
            const descripcionLimpia = await page.evaluate(() => {
              // Priority 1: Check Angular script state JSON in DOM
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

              // Priority 2: Target specific Angular description DOM elements
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

            // Sanitización en Node.js previa a Supabase
            let descripcionFinal = (descripcionLimpia || '').trim();

            if (descripcionFinal.includes('Soy MIA')) {
              descripcionFinal = descripcionFinal.split('👋🏻')[0].split('Soy MIA')[0].trim();
            }

            if (descripcionFinal.includes('{&q;') || descripcionFinal.includes('<style>')) {
              descripcionFinal = descripcionFinal.split('{&q;')[0].split('<style>')[0].trim();
            }

            // 4. Otros flags booleanos
            const deposito =
              bodyTextLower.includes('depósito') ||
              bodyTextLower.includes('deposito') ||
              bodyTextLower.includes('bodega');
            const conjunto_cerrado = bodyTextLower.includes('conjunto cerrado');

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
            } else {
              totalProcesados++;
              console.log(
                `[Progress ${index + 1}/${pendientes.length} | Total: ${totalProcesados}] ${item.id_anuncio_externo} -> Age: ${antiguedadLimpia} | Admin: $${valor_administracion ?? 0} | Lift: ${ascensor}`
              );
            }

            // Successful extraction, break retry loop
            break;
          } catch (err: any) {
            console.error(
              `[Error Ítem ${index + 1}] Falló en URL ${item.url_anuncio} (intento ${attempt}):`,
              err.message || err
            );
            if (attempt < maxAttempts) {
              await new Promise((r) => setTimeout(r, 5000));
            }
          } finally {
            if (page) {
              await page.close().catch(() => {});
              page = null;
            }
          }
        }
      }

      // 3. Batch Cool-down Periods: Close browser completely and execute 60-second rest pause
      await browser.close().catch(() => {});
      console.log(
        `[Enriquecer] [Lote #${batchNum}] Finalizado (20 inmuebles). Navegador cerrado. Pausando 60 segundos antes del siguiente lote...`
      );
      await new Promise((resolve) => setTimeout(resolve, 60000));
    }

    console.log(`\n[Enriquecer] Proceso finalizado con éxito. Total acumulado enriquecido: ${totalProcesados} inmuebles.`);
  } catch (err: any) {
    console.error('[Enriquecer] Error fatal en la ejecución por lotes:', err?.message || err);
    process.exit(1);
  }

  process.exit(0);
}

main();

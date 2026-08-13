import { chromium } from 'playwright';
import dotenv from 'dotenv';
import { supabase } from '../services/supabase.js';

dotenv.config();

async function main() {
  console.log('[DEBUG] Inicializando Playwright y Supabase...');
  const browser = await chromium.launch({ headless: false });

  try {
    const { data: pendientes, error } = await supabase
      .from('propiedades')
      .select('id, id_anuncio_externo, url_anuncio')
      .eq('activo', true)
      .or('descripcion.is.null,descripcion.eq.""')
      .limit(10);

    if (error) {
      console.error('[DEBUG ERROR] Error consultando Supabase:', error.message);
      await browser.close();
      return;
    }

    if (!pendientes || pendientes.length === 0) {
      console.log('[DEBUG] Todos los inmuebles ACTIVOS han sido enriquecidos con éxito.');
      await browser.close();
      return;
    }

    console.log(`[DEBUG] Encontradas ${pendientes.length} propiedades ACTIVAS pendientes.`);

    for (let index = 0; index < pendientes.length; index++) {
      const item = pendientes[index];
      console.log(`\n[DEBUG] [${index + 1}/${pendientes.length}] Procesando propiedad ID ${item.id} (${item.url_anuncio})...`);

      const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      });
      const page = await context.newPage();

      try {
        await page.goto(item.url_anuncio, { waitUntil: 'commit', timeout: 8000 });
        await page.waitForTimeout(1500);

        const bodyText = (await page.textContent('body')) || '';
        const bodyTextLower = bodyText.toLowerCase();

        // 1. Detección de Inactividad (marcar activo: false)
        const isInactive = bodyTextLower.includes('este inmueble ya no está disponible') ||
                           bodyTextLower.includes('inmueble no disponible') ||
                           bodyTextLower.includes('anuncio finalizado');

        if (isInactive) {
          console.log(`[Enriquecer] Propiedad ${item.id_anuncio_externo || item.id} marcando como NO DISPONIBLE (activo: false).`);
          const { data: inactiveData, error: inactiveError } = await supabase
            .from('propiedades')
            .update({ activo: false })
            .eq('id', item.id)
            .select();

          console.log('[DEBUG SUPABASE RESULT]', {
            updatedRows: inactiveData?.length,
            error: inactiveError,
          });

          await page.close();
          await context.close();
          await new Promise((resolve) => setTimeout(resolve, 1500));
          continue;
        }

        // Wait up to 4000ms for detail lists to be populated
        await page.waitForSelector('strong', { timeout: 4000 }).catch(() => {});

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
            const labelText = (strong.textContent || '').toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

            // Extract Antigüedad
            if (labelText.includes('antiguedad')) {
              const parentSpan = strong.closest('span') || strong.parentElement;
              if (parentSpan) {
                const cleanVal = parentSpan.textContent
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
            const match = bodyText.match(/antig[üu]edad\s*:?\s*(\d+\s+años?|\d+\s+a\s+\d+\s+años?|más\s+de\s+\d+\s+años|en\s+construcción|sobre\s+planos|a\s+estrenar)/i);
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
            result.ascensor = bodyText.toLowerCase().includes('con ascensor') || bodyText.toLowerCase().includes('posee ascensor');
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
            '.description'
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
        const deposito = bodyTextLower.includes('depósito') || bodyTextLower.includes('deposito');
        const conjunto_cerrado = bodyTextLower.includes('conjunto cerrado');

        console.log('[DEBUG RESULT]', { antiguedad: antiguedadLimpia, ascensor, estrato, valor_administracion });
        console.log('[DEBUG EXTRACCIÓN]', {
          id: item.id,
          url: item.url_anuncio,
          descripcionLen: descripcionFinal.length,
          deposito,
          ascensor,
          antiguedad: antiguedadLimpia,
          estrato,
          valor_administracion,
          conjunto_cerrado,
          activo: true,
        });

        const { data: updatedData, error: updateError } = await supabase
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
          .eq('id', item.id)
          .select();

        console.log('[DEBUG SUPABASE RESULT]', {
          updatedRows: updatedData?.length,
          error: updateError,
        });
      } catch (err: any) {
        console.warn(`[DEBUG WARNING] Navegación/Extracción falló para ${item.id}:`, err?.message || err);
      } finally {
        await page.close().catch(() => {});
        await context.close().catch(() => {});
      }

      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  } catch (err: any) {
    console.error('[DEBUG FATAL] Error inesperado en main:', err?.message || err);
  } finally {
    await browser.close();
    console.log('\n[DEBUG] Proceso finalizado y navegador cerrado.');
  }
}

main();

/// <reference lib="dom" />
import { chromium } from 'playwright';
import { ConfiguracionBusqueda, PropiedadEntrada } from '../types/index.js';
import { normalizarLocalidad, normalizarBarrio } from '../utils/normalizer.js';

const TARGET_URLS = [
  'https://www.ciencuadras.com/venta/bogota/apartamento/2hab-1par/desde-35-m2/de-estrato-3-y-4-y-5-y-6',
  'https://www.ciencuadras.com/venta/bogota/apartamento/3hab-1par/desde-35-m2/de-estrato-3-y-4-y-5-y-6',
];

function limpiarNombreBarrio(raw: string): string {
  if (!raw) return '';

  let limpio = raw
    // Cut everything from the first occurrence of attached digits at the end
    .replace(/\d+.*$/g, '')
    // Remove keywords if any remain
    .replace(/\b(?:m2|m²|habit|hab|banos|baños|garaje|gar|parqueadero|bogota|suba|usaquen|chapinero|teusaquillo)\b/gi, '')
    .trim();

  return limpio;
}

export async function extraerCienCuadras(config: ConfiguracionBusqueda): Promise<PropiedadEntrada[]> {
  let browser = null;
  const mapaResultados = new Map<string, PropiedadEntrada>();
  const MAX_PAGES_PER_URL = 30;

  try {
    // 1. Launch browser in non-headless mode with slowMo for visual debugging
    browser = await chromium.launch({
      headless: false,
      slowMo: 100,
    });

    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    });

    const page = await context.newPage();

    // 2. Loop through each URL in TARGET_URLS
    for (let urlIndex = 0; urlIndex < TARGET_URLS.length; urlIndex++) {
      const targetUrl = TARGET_URLS[urlIndex];
      console.log(`[CienCuadras] Iniciando búsqueda URL ${urlIndex + 1}/${TARGET_URLS.length}: ${targetUrl}...`);

      try {
        try {
          await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 40000 });
        } catch (e) {
          console.warn(`[CienCuadras] Goto domcontentloaded para URL ${urlIndex + 1} dio timeout o finalizó, continuando...`);
        }

        // 3. Execute pagination loop for currentPage = 1 up to 30
        for (let currentPage = 1; currentPage <= MAX_PAGES_PER_URL; currentPage++) {
          // Perform progressive page scroll
          await page.evaluate(async () => {
            await new Promise((resolve) => {
              let totalHeight = 0;
              const distance = 300;
              const timer = setInterval(() => {
                const scrollHeight = document.body.scrollHeight;
                window.scrollBy(0, distance);
                totalHeight += distance;
                if (totalHeight >= scrollHeight || totalHeight > 3500) {
                  clearInterval(timer);
                  resolve(true);
                }
              }, 150);
            });
          });

          await page.waitForTimeout(1000);

          // Extract cards from DOM
          const rawCards = await page.evaluate(() => {
            const selectors = ['a[href*="/inmueble/"]', '[class*="card"]', '[class*="property"]', 'article'];
            const elements = Array.from(document.querySelectorAll(selectors.join(', ')));

            return elements.map((el) => {
              const anchor = (el.tagName.toLowerCase() === 'a' ? el : el.querySelector('a[href*="/inmueble/"], a')) as HTMLAnchorElement | null;
              const href = anchor ? anchor.getAttribute('href') || '' : '';
              const idData = el.getAttribute('data-id') || el.getAttribute('id') || el.getAttribute('data-property-id') || '';

              const fullText = el.textContent || '';
              const titleEl = el.querySelector('h1, h2, h3, h4, [class*="title"]') || anchor;
              const titleText = titleEl ? titleEl.textContent?.trim() || '' : '';

              const locEl = el.querySelector('[class*="location"], [class*="ubicacion"], [class*="address"], [class*="subtitle"], [class*="sector"]');
              const locationText = locEl ? locEl.textContent?.trim() || '' : '';

              return {
                href,
                idData,
                fullText,
                titleText,
                locationText,
              };
            });
          });

          let extraidosPagina = 0;

          for (const raw of rawCards) {
            let id = raw.idData ? raw.idData.replace(/[^a-zA-Z0-9_-]/g, '') : '';
            if (!id && raw.href) {
              const matches = raw.href.match(/inmueble\/([^\/\?#]+)|([0-9a-fA-F-]{8,})/);
              if (matches) id = matches[1] || matches[2];
            }
            if (!id && raw.href) {
              const digits = raw.href.match(/(\d{5,})/);
              if (digits) id = digits[1];
            }
            if (!id && raw.href) {
              const segments = raw.href.split('/').filter(Boolean);
              id = segments[segments.length - 1] || '';
            }
            if (!id) continue;

            let cleanId = id.trim();
            if (cleanId.length > 50) {
              cleanId = cleanId.substring(0, 49);
            }

            let url = raw.href;
            if (url && !url.startsWith('http')) {
              url = `https://www.ciencuadras.com${url.startsWith('/') ? '' : '/'}${url}`;
            }
            if (!url) {
              url = `https://www.ciencuadras.com/inmueble/${cleanId}`;
            }

            let cleanUrl = url.split('?')[0].trim();
            if (cleanUrl.length > 2000) {
              cleanUrl = cleanUrl.substring(0, 1999);
            }

            // precio_venta
            const priceMatch = raw.fullText.match(/\$\s*([0-9\.\,]+)/);
            let precio_venta = 0;
            if (priceMatch) {
              const priceStr = priceMatch[1].replace(/\./g, '').replace(/,/g, '');
              precio_venta = Number(priceStr);
            }
            if (isNaN(precio_venta) || precio_venta <= 0) continue;

            // area_m2
            const areaMatch = raw.fullText.match(/([0-9\.\,]+)\s*(?:m2|m²|mts2)/i);
            let area_m2 = 0;
            if (areaMatch) {
              area_m2 = Number(areaMatch[1].replace(',', '.'));
            }
            if (isNaN(area_m2) || area_m2 <= 0) continue;

            // valor_administracion
            const adminMatch = raw.fullText.match(/(?:admin|administración|administracion)\s*(?::|\$)?\s*\$?\s*([0-9\.\,]+)/i);
            let valor_administracion: number | undefined = undefined;
            if (adminMatch) {
              const adminVal = Number(adminMatch[1].replace(/\./g, '').replace(/,/g, ''));
              if (!isNaN(adminVal) && adminVal > 0) valor_administracion = adminVal;
            }

            // Bedrooms, Bathrooms, Parking
            const habMatch = raw.fullText.match(/([0-9]+)\s*(?:hab|habitación|habitaciones|cuarto|cuartos|alcoba|alcobas)/i);
            const habitaciones = habMatch ? Number(habMatch[1]) : 0;

            const banosMatch = raw.fullText.match(/([0-9]+)\s*(?:baño|baños|bano|banos)/i);
            const banos = banosMatch ? Number(banosMatch[1]) : 0;

            const parqMatch = raw.fullText.match(/([0-9]+)\s*(?:parq|parqueadero|parqueaderos|garaje|garajes)/i);
            const parqueaderos = parqMatch ? Number(parqMatch[1]) : 0;

            // Estrato
            let estrato: number | undefined = undefined;
            const estratoMatch = raw.fullText.match(/(?:estrato|est)\s*:?\s*([3-6])/i);
            if (estratoMatch) {
              estrato = Number(estratoMatch[1]);
            } else {
              const matchAny = raw.fullText.match(/\b(estrato\s*[3-6]|[3-6]\s*estrato)\b/i);
              if (matchAny) {
                const digits = matchAny[0].match(/[3-6]/);
                if (digits) estrato = Number(digits[0]);
              }
            }

            // Location & Neighborhood
            let locString = raw.locationText;
            if (!locString || !locString.includes(',')) {
              const commaMatch = raw.fullText.match(/Bogotá\s*,\s*[^,]+(?:\s*,\s*[^,\n$]+)+/i);
              if (commaMatch) {
                locString = commaMatch[0];
              }
            }

            const parts = locString
              ? locString.split(',').map((s: string) => s.trim()).filter(Boolean)
              : [];

            let localidad = normalizarLocalidad(raw.fullText);
            let rawBarrio = '';

            if (parts.length >= 2) {
              for (const part of parts) {
                const locParsed = normalizarLocalidad(part);
                if (locParsed) {
                  localidad = locParsed;
                  break;
                }
              }
            }

            if (!localidad) continue;

            if (parts.length >= 3) {
              rawBarrio = parts[2] || parts[parts.length - 1];
            } else if (parts.length === 2 && !normalizarLocalidad(parts[1])) {
              rawBarrio = parts[1];
            }

            if (!rawBarrio) {
              const titleWords = raw.titleText
                .replace(/apartamento|venta|en|bogot[aá]|suba|usaqu[eé]n|chapinero|teusaquillo|barrios unidos/gi, '')
                .trim();
              rawBarrio = titleWords || raw.fullText;
            }

            let tituloClean = (raw.titleText || `Apartamento en ${localidad}`).trim();
            if (tituloClean.length > 99) {
              tituloClean = tituloClean.substring(0, 99);
            }

            const rawBarrioLimpio = limpiarNombreBarrio(rawBarrio);
            const rawBarrioNormalized = normalizarBarrio(rawBarrioLimpio);
            let barrioClean = rawBarrioNormalized ? rawBarrioNormalized.trim() : undefined;
            if (barrioClean && barrioClean.length > 99) {
              barrioClean = barrioClean.substring(0, 99);
            }

            const propiedad: PropiedadEntrada = {
              portal_origen: 'ciencuadras',
              id_anuncio_externo: cleanId,
              url_anuncio: cleanUrl,
              titulo: tituloClean,
              precio_venta,
              area_m2,
              valor_administracion,
              estrato,
              parqueaderos,
              habitaciones,
              banos,
              localidad,
              barrio_normalizado: barrioClean,
            };

            if (!mapaResultados.has(cleanId)) {
              mapaResultados.set(cleanId, propiedad);
              extraidosPagina++;
            }
          }

          console.log(`[CienCuadras] [URL ${urlIndex + 1}] Página ${currentPage}/30 procesada. Acumulado total: ${mapaResultados.size} (nuevos en esta página: ${extraidosPagina})`);

          // 4. If currentPage < 30, advance to next page
          if (currentPage < MAX_PAGES_PER_URL) {
            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
            await page.waitForTimeout(1000);

            const pagElements = await page.$$('ul.pagination li, [class*="pagination"] *, nav[aria-label*="pagin" i] *');
            let clicked = false;
            const targetPageNum = currentPage + 1;

            for (const el of pagElements) {
              const text = (await el.textContent())?.trim();
              if (text === String(targetPageNum) || text === '>' || text?.toLowerCase().includes('siguiente')) {
                await el.scrollIntoViewIfNeeded().catch(() => {});
                await page.evaluate((node) => (node as HTMLElement).click(), el);
                clicked = true;
                break;
              }
            }

            if (!clicked) {
              console.log(`[CienCuadras] [URL ${urlIndex + 1}] No se encontró elemento de página ${targetPageNum}. Finalizando paginación de esta URL.`);
              break;
            }

            try {
              await page.waitForLoadState('networkidle', { timeout: 15000 });
            } catch (_) {}
            await page.waitForTimeout(3500);
          }
        }
      } catch (urlError) {
        console.error(`[CienCuadras] Error al procesar URL ${urlIndex + 1} (${targetUrl}):`, urlError);
      }
    }

    const acumulados = Array.from(mapaResultados.values());
    console.log(`[CienCuadras] Scraping completado en todas las URLs (${TARGET_URLS.length}). Total final de inmuebles únicos: ${acumulados.length}`);
    return acumulados;
  } catch (error) {
    console.error('[CienCuadras Scraper] Error crítico al ejecutar scraper:', error);
    return Array.from(mapaResultados.values());
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

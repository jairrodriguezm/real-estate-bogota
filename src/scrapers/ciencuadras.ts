/// <reference lib="dom" />
import { chromium, BrowserContext, Page, Browser } from 'playwright';
import { ConfiguracionBusqueda, PropiedadEntrada } from '../types/index.js';
import { normalizarLocalidad, normalizarBarrio } from '../utils/normalizer.js';
import { supabase, procesarInmueblesBatch } from '../services/supabase.js';

const TARGET_URLS = [
  'https://www.ciencuadras.com/venta/bogota/apartamento/1par/desde-32-m2/de-estrato-3-y-4-y-5-y-6?q=bogota',
  'https://www.ciencuadras.com/venta/bogota/apartamento/2par/desde-32-m2/de-estrato-3-y-4-y-5-y-6',
];

function limpiarNombreBarrio(raw: string): string {
  if (!raw) return '';

  let limpio = raw
    .replace(/\d+.*$/g, '')
    .replace(/\b(?:m2|m²|habit|hab|banos|baños|garaje|gar|parqueadero|bogota|suba|usaquen|chapinero|teusaquillo|kennedy)\b/gi, '')
    .trim();

  return limpio;
}

async function extraerDetallePropiedad(
  browser: Browser,
  url: string
): Promise<Partial<PropiedadEntrada>> {
  let detailPage: Page | null = null;
  try {
    detailPage = await browser.newPage();

    // Block unnecessary heavy resources to accelerate load and prevent navigation crashes
    await detailPage.route('**/*', (route) => {
      const resourceType = route.request().resourceType();
      if (['image', 'media', 'font', 'stylesheet'].includes(resourceType)) {
        route.abort();
      } else {
        route.continue();
      }
    });

    await detailPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 });

    const bodyText = (await detailPage.textContent('body'))?.toLowerCase() || '';

    const deposito =
      bodyText.includes('depósito') ||
      bodyText.includes('deposito') ||
      bodyText.includes('bodega');

    const ascensor = bodyText.includes('ascensor');

    const conjunto_cerrado = bodyText.includes('conjunto cerrado');

    const descElement = await detailPage.$('.description-content, [class*="description"], #description');
    let descripcion = descElement ? (await descElement.textContent())?.trim() : undefined;
    if (descripcion && descripcion.length === 0) {
      descripcion = undefined;
    }

    let antiguedad: string | undefined = undefined;
    const rawBodyText = (await detailPage.textContent('body')) || '';
    const antiguedadMatch = rawBodyText.match(/(?:antigüedad|antiguedad|años de construido|tiempo de construido)\s*:?\s*([^\n\r,.]+)/i);
    if (antiguedadMatch) {
      antiguedad = antiguedadMatch[1].trim();
    } else {
      const ageRangeMatch = rawBodyText.match(/(?:sobre planos|en construcción|a estrenar|1 a 8 años|9 a 15 años|16 a 30 años|más de 20 años|más de 30 años|remodelar|entre 1 y 5 años|\d+\s*años)/i);
      if (ageRangeMatch) {
        antiguedad = ageRangeMatch[0].trim();
      }
    }

    let vista: string | undefined = undefined;
    const vistaMatch = rawBodyText.match(/(?:vista|tipo de vista)\s*:?\s*([^\n\r,.]+)/i);
    if (vistaMatch) {
      vista = vistaMatch[1].trim();
    } else {
      const vistaKeyword = rawBodyText.match(/(?:vista exterior|vista interior|vista panorámica|vista panoramica)/i);
      if (vistaKeyword) {
        vista = vistaKeyword[0].trim();
      }
    }

    const antiguedadLimpia = antiguedad ? antiguedad.trim().substring(0, 49) : undefined;
    const vistaLimpia = vista ? vista.trim().substring(0, 49) : undefined;

    return {
      descripcion,
      deposito,
      ascensor,
      antiguedad: antiguedadLimpia,
      vista: vistaLimpia,
      conjunto_cerrado,
    };
  } catch (err) {
    console.warn(`[PHASE 3] Skipping detail for ${url} due to navigation or extraction error.`);
    return {};
  } finally {
    if (detailPage) {
      await detailPage.close().catch(() => {});
    }
  }
}

export async function enriquecerDetallesPendientes(browser: Browser, limit = 50): Promise<void> {
  console.log(`[PHASE 3] Buscando propiedades en Supabase con detalles pendientes (límite: ${limit})...`);

  try {
    const { data: pendientes, error } = await supabase
      .from('propiedades')
      .select('id, url_anuncio')
      .or('descripcion.is.null,antiguedad.is.null')
      .limit(limit);

    if (error) {
      console.error('[PHASE 3] Error al consultar propiedades pendientes en Supabase:', error.message);
      return;
    }

    if (!pendientes || pendientes.length === 0) {
      console.log('[PHASE 3] No hay propiedades pendientes por enriquecer detalles.');
      return;
    }

    console.log(`[PHASE 3] Encontradas ${pendientes.length} propiedades pendientes por enriquecer detalles.`);

    let count = 0;
    for (const item of pendientes) {
      count++;
      console.log(`[PHASE 3] Enriqueciendo detalle (${count}/${pendientes.length}): ${item.url_anuncio}`);

      try {
        const detalle = await extraerDetallePropiedad(browser, item.url_anuncio);

        const updatePayload: Record<string, any> = {};
        if (detalle.descripcion) updatePayload.descripcion = detalle.descripcion;
        if (detalle.deposito !== undefined) updatePayload.deposito = detalle.deposito;
        if (detalle.ascensor !== undefined) updatePayload.ascensor = detalle.ascensor;

        if (detalle.antiguedad) {
          const antiguedadLimpia = detalle.antiguedad.trim().substring(0, 49);
          if (antiguedadLimpia.length > 0) {
            updatePayload.antiguedad = antiguedadLimpia;
          }
        }

        if (detalle.vista) {
          const vistaLimpia = detalle.vista.trim().substring(0, 49);
          if (vistaLimpia.length > 0) {
            updatePayload.vista = vistaLimpia;
          }
        }

        if (detalle.conjunto_cerrado !== undefined) updatePayload.conjunto_cerrado = detalle.conjunto_cerrado;

        if (Object.keys(updatePayload).length > 0) {
          const { error: errUpdate } = await supabase
            .from('propiedades')
            .update(updatePayload)
            .eq('id', item.id);

          if (errUpdate) {
            console.warn(`[PHASE 3] Error actualizando registro ${item.id} en Supabase. Payload: ${JSON.stringify(updatePayload)} - Error: ${errUpdate.message}`);
          }
        }
      } catch (err: any) {
        console.warn(`[PHASE 3] Error procesando detalle para ${item.url_anuncio}:`, err?.message || err);
      }

      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    console.log('[PHASE 3] Finalizado enriquecimiento de detalles.');
  } catch (err: any) {
    console.error('[PHASE 3] Error general en el bucle de enriquecimiento:', err?.message || err);
  }
}

export async function extraerCienCuadras(config: ConfiguracionBusqueda): Promise<PropiedadEntrada[]> {
  let browser: Browser | null = null;
  const mapaResultados = new Map<string, PropiedadEntrada>();
  const scrapedExternalIds = new Set<string>();

  try {
    const isHeadless = process.env.HEADLESS !== 'false';

    browser = await chromium.launch({
      headless: isHeadless,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    });

    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    });

    const page = await context.newPage();

    // PHASE 1: Collect All Listings in Memory
    console.log('[CienCuadras] [PHASE 1] Iniciando extracción de todos los listados en memoria...');

    for (let urlIndex = 0; urlIndex < TARGET_URLS.length; urlIndex++) {
      const targetUrl = TARGET_URLS[urlIndex];
      console.log(`[CienCuadras] [PHASE 1] Búsqueda URL ${urlIndex + 1}/${TARGET_URLS.length}: ${targetUrl}...`);

      try {
        try {
          await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 40000 });
        } catch (e) {
          console.warn(`[CienCuadras] Goto domcontentloaded para URL ${urlIndex + 1} dio timeout o finalizó, continuando...`);
        }

        let pageIndex = 1;
        let hasNextPage = true;

        while (hasNextPage) {
          // Perform progressive scroll down page
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

          // Extract property cards from DOM
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
            scrapedExternalIds.add(cleanId);

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
                .replace(/apartamento|venta|en|bogot[aá]|suba|usaqu[eé]n|chapinero|teusaquillo|barrios unidos|kennedy/gi, '')
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
            }
          }

          console.log(`[CienCuadras] Página ${pageIndex} procesada. Total acumulado en memoria: ${mapaResultados.size}`);

          // Check for next page element dynamically
          await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
          await page.waitForTimeout(1000);

          const pagElements = await page.$$('ul.pagination li, [class*="pagination"] *, nav[aria-label*="pagin" i] *');
          let clicked = false;
          const targetPageNum = pageIndex + 1;

          for (const el of pagElements) {
            const isTarget = await el.evaluate((node, targetNum) => {
              const text = (node.textContent || '').trim();
              const isDisabled =
                node.hasAttribute('disabled') ||
                node.classList.contains('disabled') ||
                node.getAttribute('aria-disabled') === 'true';
              if (isDisabled) return false;
              return text === String(targetNum) || text === '>' || text.toLowerCase().includes('siguiente');
            }, targetPageNum);

            if (isTarget) {
              await el.scrollIntoViewIfNeeded().catch(() => {});
              await page.evaluate((node) => (node as HTMLElement).click(), el);
              clicked = true;
              break;
            }
          }

          if (!clicked) {
            console.log(`[CienCuadras] [URL ${urlIndex + 1}] No se encontró elemento de siguiente página (${targetPageNum}). Finalizando paginación de esta URL.`);
            hasNextPage = false;
          } else {
            pageIndex++;
            try {
              await page.waitForLoadState('networkidle', { timeout: 15000 });
            } catch (_) {}
            await page.waitForTimeout(3000);
          }
        }
      } catch (urlError) {
        console.error(`[CienCuadras] Error al procesar URL ${urlIndex + 1} (${targetUrl}):`, urlError);
      }
    }

    // PHASE 2: Single Mass Save to Supabase
    const items = Array.from(mapaResultados.values());
    console.log(`[CienCuadras] [PHASE 2] Iniciando guardado masivo de ${items.length} inmuebles en Supabase...`);

    if (items.length > 0) {
      await procesarInmueblesBatch(items, config);
    }
    console.log(`[CienCuadras] Guardado masivo completado. ${items.length} registros sincronizados en Supabase.`);

    // RECONCILIATION PHASE: Purge inactive listings not found in current scrape
    console.log('[Reconciliación] Iniciando fase de reconciliación de inmuebles...');
    try {
      const { data: dbProps, error: dbError } = await supabase
        .from('propiedades')
        .select('id, id_anuncio_externo')
        .eq('activo', true)
        .eq('portal_origen', 'ciencuadras');

      if (dbError) {
        console.error('[Reconciliación] Error al consultar inmuebles en Supabase:', dbError.message);
      } else {
        const inactiveIdsToDelete = (dbProps || [])
          .filter((p) => p.id_anuncio_externo && !scrapedExternalIds.has(p.id_anuncio_externo))
          .map((p) => p.id);

        if (inactiveIdsToDelete.length > 0) {
          for (let i = 0; i < inactiveIdsToDelete.length; i += 100) {
            const chunk = inactiveIdsToDelete.slice(i, i + 100);
            const { error: deleteError } = await supabase
              .from('propiedades')
              .delete()
              .in('id', chunk);

            if (deleteError) {
              console.error('[Reconciliación] Error al eliminar inmuebles inactivos:', deleteError.message);
            }
          }
          console.log(`[Reconciliación] Se eliminaron ${inactiveIdsToDelete.length} inmuebles que ya no están publicados en CienCuadras.`);
        } else {
          console.log('[Reconciliación] Todos los inmuebles en base de datos siguen vigentes.');
        }
      }
    } catch (reconcileErr: any) {
      console.error('[Reconciliación] Error general durante la reconciliación:', reconcileErr?.message || reconcileErr);
    }

    // PHASE 3: Detail Enrichment Loop (Desacoplado - ejecutar vía npm run enriquecer)
    // if (browser && items.length > 0) {
    //   console.log('[CienCuadras] [PHASE 3] Iniciando bucle de enriquecimiento de detalles...');
    //   await enriquecerDetallesPendientes(browser, 50);
    // }

    console.log(`[CienCuadras] Proceso de extracción base completado exitosamente. Total final: ${items.length} propiedades.`);
    return items;
  } catch (error) {
    console.error('[CienCuadras Scraper] Error crítico en pipeline:', error);
    return Array.from(mapaResultados.values());
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

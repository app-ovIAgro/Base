/**
 * ============================================================
 * SERVICE WORKER - OvIAgro La Rioja
 * ============================================================
 * Archivo: sw.js
 * Propósito: Garantizar el funcionamiento OFFLINE-FIRST de la PWA.
 *            Este script se ejecuta en un hilo separado del navegador
 *            (en segundo plano) y actúa como un proxy de red local,
 *            interceptando todas las peticiones para servirlas desde
 *            la caché del teléfono sin necesidad de conexión a internet.
 *
 * Estrategia: "Cache-First" (La caché primero).
 *             Ante cualquier petición, primero buscamos en la caché.
 *             Si no encontramos el recurso, recién entonces vamos a la red.
 *             Ideal para zonas rurales con señal intermitente o nula.
 *
 * Autoría: Escuela Agrotécnica - La Rioja
 * ============================================================
 */

'use strict';

// --- CONSTANTES DE CONTROL DE VERSIÓN ---

/**
 * NOMBRE_CACHE: Identificador único de esta versión de la caché.
 * IMPORTANTE: Al modificar los archivos de la app, se DEBE cambiar
 * este nombre (ej: 'oviagro-v2') para forzar que el SW antiguo
 * se reemplace por el nuevo y los usuarios reciban la actualización.
 */
const NOMBRE_CACHE = 'oviagro-v1';

/**
 * ARCHIVOS_A_CACHEAR: Lista de todos los recursos estáticos que se
 * descargarán y almacenarán localmente durante la instalación del SW.
 * Estos archivos son todo lo que la app necesita para funcionar sin red.
 */
const ARCHIVOS_A_CACHEAR = [
  './',
  './index.html',
  './app.js',
  './manifest.json'
];


// ============================================================
// EVENTO: install
// ============================================================
/**
 * Se dispara la PRIMERA VEZ que el Service Worker se instala en el
 * dispositivo, o cuando se detecta una nueva versión del archivo sw.js.
 *
 * Tarea: Abrir (o crear) el almacén de caché y descargar todos los
 * archivos esenciales de la app para tenerlos disponibles offline.
 *
 * `event.waitUntil()` le dice al navegador que NO finalice la instalación
 * hasta que la Promise interior se resuelva (todos los archivos cacheados).
 */
self.addEventListener('install', (event) => {
  console.log(`[SW OvIAgro] Instalando versión de caché: ${NOMBRE_CACHE}`);

  event.waitUntil(
    caches.open(NOMBRE_CACHE)
      .then((cache) => {
        console.log('[SW OvIAgro] Caché abierta. Descargando archivos esenciales...');
        // `addAll` descarga y guarda TODOS los archivos de la lista.
        // Si falla UNO SOLO, toda la instalación falla (comportamiento seguro).
        return cache.addAll(ARCHIVOS_A_CACHEAR);
      })
      .then(() => {
        console.log('[SW OvIAgro] ✅ Todos los archivos cacheados correctamente.');
        // `skipWaiting()` fuerza al nuevo SW a tomar el control inmediatamente,
        // sin esperar a que se cierren las pestañas con la versión vieja.
        return self.skipWaiting();
      })
      .catch((error) => {
        console.error('[SW OvIAgro] ❌ Error durante la instalación de la caché:', error);
      })
  );
});


// ============================================================
// EVENTO: activate
// ============================================================
/**
 * Se dispara DESPUÉS de la instalación exitosa, cuando el SW toma
 * el control activo del sitio. Es el momento ideal para "limpiar la casa":
 * eliminar cachés de versiones anteriores que ya no se necesitan,
 * liberando espacio de almacenamiento en el dispositivo del productor.
 *
 * `event.waitUntil()` mantiene al SW en estado "activating" hasta
 * que terminemos la limpieza.
 */
self.addEventListener('activate', (event) => {
  console.log(`[SW OvIAgro] Activando Service Worker. Limpiando cachés antiguas...`);

  event.waitUntil(
    caches.keys()
      .then((nombresDeCache) => {
        // Creamos un array de promesas: una por cada caché encontrada.
        const promesasDeLimpieza = nombresDeCache.map((nombreCache) => {
          // Si el nombre de la caché encontrada NO es la versión actual,
          // es una versión vieja que debemos eliminar.
          if (nombreCache !== NOMBRE_CACHE) {
            console.log(`[SW OvIAgro] 🗑️ Eliminando caché obsoleta: ${nombreCache}`);
            return caches.delete(nombreCache);
          }
        });
        return Promise.all(promesasDeLimpieza);
      })
      .then(() => {
        console.log('[SW OvIAgro] ✅ Limpieza completa. SW listo para controlar la app.');
        // `clients.claim()` hace que el SW tome el control de TODAS las
        // páginas abiertas de la app inmediatamente, sin esperar recarga.
        return self.clients.claim();
      })
      .catch((error) => {
        console.error('[SW OvIAgro] ❌ Error durante la activación:', error);
      })
  );
});


// ============================================================
// EVENTO: fetch
// ============================================================
/**
 * Se dispara CADA VEZ que la app hace una petición de red (cargar
 * un archivo HTML, JS, imagen, etc.). Este es el corazón del SW:
 * actúa como un "portero" que intercepta las peticiones.
 *
 * Estrategia aplicada: CACHE-FIRST (Caché Primero)
 * 1. Buscar el recurso pedido en la caché local.
 * 2. Si lo encontramos → devolvemos la respuesta en caché (OFFLINE ✅).
 * 3. Si NO lo encontramos → intentamos buscarlo en la red.
 * 4. Si la red responde → guardamos una copia en caché para el futuro.
 * 5. Si la red también falla → la app maneja el error graciosamente.
 */
self.addEventListener('fetch', (event) => {
  // Solo interceptamos peticiones GET (las de carga de recursos).
  // Las peticiones POST u otras las dejamos pasar normalmente.
  if (event.request.method !== 'GET') {
    return;
  }

  event.respondWith(
    caches.match(event.request)
      .then((respuestaEnCache) => {
        // --- CASO 1: El recurso está en caché → Servir offline ---
        if (respuestaEnCache) {
          // Retornamos directamente la respuesta guardada.
          // La app abre al instante, aunque no haya internet.
          return respuestaEnCache;
        }

        // --- CASO 2: El recurso NO está en caché → Ir a la red ---
        console.log(`[SW OvIAgro] 🌐 Recurso no en caché, buscando en red: ${event.request.url}`);

        // Clonamos la petición porque los objetos Request solo se pueden
        // "consumir" una vez. Necesitamos una copia para guardar en caché.
        const peticionClonada = event.request.clone();

        return fetch(peticionClonada)
          .then((respuestaDeRed) => {
            // Verificamos que la respuesta de la red sea válida.
            // (status 0 es para peticiones cross-origin opacas, también válidas)
            if (!respuestaDeRed || respuestaDeRed.status !== 200 && respuestaDeRed.type !== 'opaque') {
              return respuestaDeRed;
            }

            // Clonamos la respuesta de la red también, por la misma razón.
            const respuestaParaCache = respuestaDeRed.clone();

            // Guardamos el nuevo recurso en caché para futuras visitas offline.
            caches.open(NOMBRE_CACHE).then((cache) => {
              cache.put(event.request, respuestaParaCache);
            });

            return respuestaDeRed;
          })
          .catch((errorDeRed) => {
            // --- CASO 3: Sin caché Y sin red → La app sigue funcionando ---
            // Gracias a que `index.html` siempre está en caché desde la
            // instalación, el usuario puede seguir operando la app.
            console.warn(`[SW OvIAgro] ⚠️ Sin red y sin caché para: ${event.request.url}`, errorDeRed);
          });
      })
  );
});

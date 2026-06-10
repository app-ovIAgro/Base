/**
 * ============================================================
 * SERVICE WORKER — OvIAgro PWA
 * ============================================================
 * Archivo: sw.js
 * Propósito: Garantizar el funcionamiento OFFLINE-FIRST de la PWA.
 *            Este script se ejecuta en un hilo separado del navegador
 *            (en segundo plano) y actúa como un proxy de red local,
 *            interceptando todas las peticiones para servirlas desde
 *            la caché del teléfono sin necesidad de conexión a internet.
 *
 * Estrategia: "Cache-First" (La caché primero).
 *             Ante cualquier petición de un recurso LOCAL, primero
 *             buscamos en la caché. Si no está, vamos a la red y
 *             guardamos una copia para la próxima vez.
 *             Las peticiones a Firebase/Google se dejan pasar siempre
 *             a la red para no interferir con la autenticación y los datos.
 * ============================================================
 */

'use strict';

/* ============================================================
   CONSTANTES DE CONTROL DE VERSIÓN
   IMPORTANTE: Cada vez que modifiques los archivos de la app,
   incrementá el número de versión (ej: 'oviagro-pwa-v2') para
   forzar que los usuarios reciban la actualización automáticamente.
============================================================ */

/** Nombre único de esta versión de la caché */
const NOMBRE_CACHE = 'oviagro-pwa-v2';

/**
 * Lista de archivos esenciales que se descargarán y guardarán
 * durante la instalación del SW. Son todo lo necesario para
 * que la app funcione sin internet desde el primer uso.
 */
const ARCHIVOS_A_CACHEAR = [
  './',
  './index.html',
  './app.js',
  './manifest.json',
  // Íconos obligatorios de la PWA (para instalación y pantalla de inicio)
  './icons/icon-192x192.png',
  './icons/icon-512x512.png',
];

/**
 * Dominios que deben ir SIEMPRE a la red (nunca servir desde caché).
 * Incluye Firebase y Google para no bloquear la autenticación ni
 * la escritura/lectura de datos en Firestore.
 */
const DOMINIOS_SOLO_RED = [
  'firebaseapp.com',
  'googleapis.com',
  'gstatic.com',
  'firestore.googleapis.com',
  'identitytoolkit.googleapis.com',
  'securetoken.googleapis.com',
];


// ============================================================
// EVENTO: install
// ============================================================
/**
 * Se dispara la PRIMERA VEZ que el Service Worker se instala,
 * o cuando se detecta una nueva versión del archivo sw.js.
 *
 * Tarea: Abrir el almacén de caché y descargar todos los
 * archivos esenciales para tenerlos disponibles offline.
 */
self.addEventListener('install', (evento) => {
  console.log(`[SW OvIAgro] ⚙️ Instalando versión de caché: ${NOMBRE_CACHE}`);

  evento.waitUntil(
    caches.open(NOMBRE_CACHE)
      .then((cache) => {
        console.log('[SW OvIAgro] Caché abierta. Descargando archivos esenciales...');
        // addAll descarga y guarda TODOS los archivos de la lista.
        // Si falla UNO SOLO, toda la instalación falla (comportamiento seguro).
        return cache.addAll(ARCHIVOS_A_CACHEAR);
      })
      .then(() => {
        console.log('[SW OvIAgro] ✅ Todos los archivos cacheados correctamente.');
        // skipWaiting() fuerza al nuevo SW a tomar el control inmediatamente,
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
 * Se dispara DESPUÉS de la instalación exitosa. Es el momento
 * ideal para limpiar cachés de versiones anteriores que ya no
 * se necesitan, liberando espacio en el dispositivo del productor.
 */
self.addEventListener('activate', (evento) => {
  console.log('[SW OvIAgro] 🚀 Activando Service Worker. Limpiando cachés antiguas...');

  evento.waitUntil(
    caches.keys()
      .then((nombresDeCache) => {
        // Crear un array de promesas: una por cada caché encontrada.
        const promesasDeLimpieza = nombresDeCache.map((nombreCache) => {
          // Si el nombre de la caché NO es la versión actual, es obsoleta.
          if (nombreCache !== NOMBRE_CACHE) {
            console.log(`[SW OvIAgro] 🗑️ Eliminando caché obsoleta: ${nombreCache}`);
            return caches.delete(nombreCache);
          }
        });
        return Promise.all(promesasDeLimpieza);
      })
      .then(() => {
        console.log('[SW OvIAgro] ✅ Limpieza completa. SW listo para controlar la app.');
        // clients.claim() hace que el SW tome control de TODAS las páginas
        // abiertas inmediatamente, sin esperar recarga del usuario.
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
 * Se dispara CADA VEZ que la app hace una petición de red.
 * Este es el corazón del SW: actúa como un "portero" que
 * intercepta las peticiones y decide cómo responderlas.
 *
 * Estrategia aplicada: CACHE-FIRST para recursos locales.
 * Las peticiones a Firebase siempre van a la red directamente.
 *
 * Flujo para recursos locales:
 * 1. Buscar el recurso en la caché local.
 * 2. Si está → devolver desde caché (OFFLINE ✅).
 * 3. Si NO está → buscar en la red.
 * 4. Si la red responde → guardar copia en caché y devolver.
 * 5. Si la red falla → la app sigue funcionando con lo que tiene en caché.
 */
self.addEventListener('fetch', (evento) => {
  // Solo interceptamos peticiones GET (las de carga de recursos).
  // Las peticiones POST/PUT/DELETE (escritura a Firestore) las dejamos pasar.
  if (evento.request.method !== 'GET') {
    return;
  }

  // Verificar si la URL pertenece a un dominio de Firebase/Google.
  // En ese caso, dejamos pasar la petición directamente a la red
  // para no interferir con la autenticación ni los datos en la nube.
  const url = new URL(evento.request.url);
  const esDominioDeRed = DOMINIOS_SOLO_RED.some((dominio) =>
    url.hostname.includes(dominio)
  );

  if (esDominioDeRed) {
    // Petición a Firebase/Google → pasar directo a la red sin tocar
    return;
  }

  // Para todos los demás recursos (locales), aplicar Cache-First.
  evento.respondWith(
    caches.match(evento.request)
      .then((respuestaEnCache) => {
        // CASO 1: El recurso está en caché → Servir offline al instante
        if (respuestaEnCache) {
          return respuestaEnCache;
        }

        // CASO 2: El recurso NO está en caché → Ir a la red
        console.log(`[SW OvIAgro] 🌐 Recurso no en caché, buscando en red: ${evento.request.url}`);

        // Clonar la petición porque los objetos Request solo se pueden
        // "consumir" una vez.
        const peticionClonada = evento.request.clone();

        return fetch(peticionClonada)
          .then((respuestaDeRed) => {
            // Verificar que la respuesta de la red sea válida.
            if (!respuestaDeRed || respuestaDeRed.status !== 200 && respuestaDeRed.type !== 'opaque') {
              return respuestaDeRed;
            }

            // Clonar la respuesta para poder guardarla en caché Y devolverla.
            const respuestaParaCache = respuestaDeRed.clone();

            // Guardar el nuevo recurso en caché para futuras visitas offline.
            caches.open(NOMBRE_CACHE).then((cache) => {
              cache.put(evento.request, respuestaParaCache);
            });

            return respuestaDeRed;
          })
          .catch((errorDeRed) => {
            // CASO 3: Sin caché Y sin red → La app sigue funcionando
            // gracias a que index.html siempre está en caché desde la instalación.
            console.warn(`[SW OvIAgro] ⚠️ Sin red y sin caché para: ${evento.request.url}`, errorDeRed);
          });
      })
  );
});

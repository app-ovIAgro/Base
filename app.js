/**
 * ============================================================
 * APP.JS — El Cerebro de OvIAgro PWA
 * ============================================================
 * Archivo: app.js
 * Propósito: Controla TODA la lógica de la aplicación.
 *   - Registro del Service Worker (PWA offline)
 *   - Firebase Authentication con Google Sign-In
 *   - Firebase Firestore para persistencia en la nube
 *   - Persistencia offline nativa de Firestore
 *   - Enrutador SPA (cambio de vistas sin recargar la página)
 *   - Fotos en Base64 guardadas como campo de texto en Firestore
 *
 * Principios aplicados:
 *   - Offline-First: Firestore cachea localmente sin conexión
 *   - Manejo robusto de errores (try/catch en toda operación)
 *   - Sanitización de entradas para prevenir inyecciones XSS
 *   - Datos vinculados al operario (operario_uid) por seguridad
 * ============================================================
 */

'use strict';

/* ============================================================
   MÓDULO 0: REGISTRO DEL SERVICE WORKER (PWA)
   Se registra PRIMERO, antes de cualquier otra inicialización,
   para activar el motor offline lo antes posible.
============================================================ */

/**
 * Registra el Service Worker si el navegador lo soporta.
 * El SW interceptará las peticiones de red y servirá la app desde caché.
 */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const registro = await navigator.serviceWorker.register('./sw.js', { scope: './' });
      console.log('[SW] ✅ Service Worker registrado. Scope:', registro.scope);
      registro.addEventListener('updatefound', () => {
        console.log('[SW] 🔄 Nueva versión disponible.');
        mostrarToast('🔄 Actualizando la app...', 'info', 5000);
      });
    } catch (error) {
      console.error('[SW] ❌ Error al registrar el Service Worker:', error);
    }
  });
}

/* ============================================================
   EVENTOS DE INSTALACIÓN PWA (Instalar en Pantalla de Inicio)
   Captura el prompt de instalación nativo para ofrecerlo
   de forma explícita al usuario a través de un botón.
 ============================================================ */

window.addEventListener('beforeinstallprompt', (e) => {
  // Prevenir que el navegador muestre automáticamente el prompt
  e.preventDefault();
  // Guardar el evento para dispararlo luego
  deferredPrompt = e;
  console.log('[PWA] 📲 Evento beforeinstallprompt capturado.');

  // Mostrar el botón de instalación si está disponible en el DOM
  const btnInstalar = document.getElementById('btn-instalar-pwa');
  if (btnInstalar) {
    btnInstalar.style.display = 'block';
  }
});

window.addEventListener('appinstalled', (e) => {
  console.log('[PWA] 🐑 Aplicación instalada con éxito.');
  // Limpiar el deferredPrompt
  deferredPrompt = null;
  // Ocultar el botón si siguiera visible
  const btnInstalar = document.getElementById('btn-instalar-pwa');
  if (btnInstalar) {
    btnInstalar.style.display = 'none';
  }
  // Lanzar confirmación amigable en pantalla
  mostrarToast('¡OvIAgro instalada con éxito en tu pantalla de inicio! 🐑', 'exito', 5000);
});


/* ============================================================
   MÓDULO 1: CONFIGURACIÓN E INICIALIZACIÓN DE FIREBASE
   Credenciales reales del proyecto oviagro-b28c5.
   Aquí se enciende toda la infraestructura de la nube.
============================================================ */

/**
 * Configuración del proyecto Firebase.
 * Para Firebase JS SDK v7.20.0 y versiones posteriores, measurementId es opcional.
 */
const firebaseConfig = {
  apiKey:            "AIzaSyDP1Bt-bTk39wr0ctC9l7kGc1P_ZsaRigo",
  authDomain:        "oviagro-b28c5.firebaseapp.com",
  projectId:         "oviagro-b28c5",
  storageBucket:     "oviagro-b28c5.firebasestorage.app",
  messagingSenderId: "634144367466",
  appId:             "1:634144367466:web:b4dffd2e23c14733fa3b13",
  measurementId:     "G-NHVSKDV21T"
};

// Inicializar Firebase con la configuración del proyecto
firebase.initializeApp(firebaseConfig);

/**
 * Referencia a los servicios de Firebase que usaremos.
 * Se declaran aquí para que sean accesibles en todo el archivo.
 */
const auth = firebase.auth();
const db   = firebase.firestore();

/**
 * Activar la persistencia offline nativa de Firestore.
 * Esto permite que los datos guardados estén disponibles aunque
 * el dispositivo no tenga conexión a internet en el campo.
 * Firestore los sincronizará automáticamente al recuperar señal.
 */
db.enablePersistence({ synchronizeTabs: true })
  .then(() => {
    console.log('[Firestore] ✅ Persistencia offline activada correctamente.');
  })
  .catch((error) => {
    if (error.code === 'failed-precondition') {
      // Ocurre si hay múltiples pestañas abiertas; funciona igual pero sin sync entre tabs
      console.warn('[Firestore] ⚠️ Persistencia offline: múltiples pestañas abiertas.');
    } else if (error.code === 'unimplemented') {
      // El navegador no soporta persistencia offline (muy poco común en móviles modernos)
      console.warn('[Firestore] ⚠️ Este navegador no soporta persistencia offline.');
    } else {
      console.error('[Firestore] ❌ Error al activar persistencia:', error);
    }
  });


/* ============================================================
   MÓDULO 2: AUTENTICACIÓN CON GOOGLE (Firebase Auth)
   Gestiona el flujo de login/logout del operario.
============================================================ */

/** @type {Object|null} Usuario actualmente autenticado (objeto Firebase User) */
let usuarioActual = null;

/** @type {Function|null} Función de desuscripción del listener de Firestore en tiempo real */
let desuscribirAnimales = null;

/** @type {Object|null} Evento diferido para la instalación PWA */
let deferredPrompt = null;

/**
 * Dispara el flujo de autenticación con Google mediante un popup.
 * Al completarse, onAuthStateChanged detecta el cambio y muestra la app.
 */
async function iniciarSesionConGoogle() {
  const btnLogin    = document.getElementById('btn-google-login');
  const msgCargando = document.getElementById('login-cargando');

  try {
    // Deshabilitar el botón y mostrar estado de carga
    if (btnLogin)    btnLogin.disabled = true;
    if (msgCargando) msgCargando.classList.add('visible');

    // Proveedor de autenticación de Google
    const proveedor = new firebase.auth.GoogleAuthProvider();
    // Solicitar siempre al usuario que elija su cuenta de Google
    proveedor.setCustomParameters({ prompt: 'select_account' });

    // Abrir el popup de autenticación de Google
    await auth.signInWithPopup(proveedor);
    // onAuthStateChanged detectará el login y mostrará la app automáticamente
    console.log('[Auth] ✅ Login con Google completado.');

  } catch (error) {
    console.error('[Auth] ❌ Error al iniciar sesión con Google:', error);

    // Mensajes de error amigables según el código del error
    const mensajesError = {
      'auth/popup-closed-by-user':    'Cerraste la ventana de Google. Intentá de nuevo.',
      'auth/popup-blocked':           'El popup fue bloqueado. Habilitá las ventanas emergentes.',
      'auth/network-request-failed':  'Sin conexión. Necesitás internet para ingresar.',
      'auth/cancelled-popup-request': 'Operación cancelada. Intentá de nuevo.',
    };
    const msg = mensajesError[error.code] || `Error al ingresar: ${error.message}`;
    mostrarToast(msg, 'error', 6000);

    // Rehabilitar el botón en caso de error
    if (btnLogin)    btnLogin.disabled = false;
    if (msgCargando) msgCargando.classList.remove('visible');
  }
}

/**
 * Cierra la sesión del operario actual.
 * Cancela las suscripciones a Firestore y sale de la cuenta de Google.
 */
async function cerrarSesion() {
  try {
    // Cancelar todas las suscripciones activas de Firestore
    if (desuscribirAnimales) {
      desuscribirAnimales();
      desuscribirAnimales = null;
    }
    if (desuscribirTareas) {
      desuscribirTareas();
      desuscribirTareas = null;
    }
    if (desuscribirPredio) {
      desuscribirPredio();
      desuscribirPredio = null;
    }
    await auth.signOut();
    console.log('[Auth] ✅ Sesión cerrada correctamente.');
  } catch (error) {
    console.error('[Auth] ❌ Error al cerrar sesión:', error);
    mostrarToast('Error al cerrar sesión.', 'error');
  }
}

/**
 * Escucha en tiempo real los cambios en el estado de autenticación.
 * Punto de entrada principal después de la carga del DOM.
 */
auth.onAuthStateChanged(async (usuario) => {
  const vistaLogin   = document.getElementById('vista-login');
  const appContainer = document.getElementById('app-container');
  const navbar       = document.getElementById('navbar');

  if (usuario) {
    // ── OPERARIO AUTENTICADO ──
    usuarioActual = usuario;
    console.log(`[Auth] ✅ Operario autenticado: ${usuario.email} (UID: ${usuario.uid})`);

    // Mostrar interfaz principal
    if (vistaLogin)   vistaLogin.classList.add('oculto');
    if (appContainer) appContainer.style.display = 'block';
    if (navbar)       navbar.style.display = 'flex';

    // Inicializar componentes base de la app una sola vez
    inicializarAppUnaVez();

    // Migrar datos locales previos a la base de datos Firestore
    await migrarDatosLocalesAFirestore();

    // Activar suscripciones en tiempo real
    suscribirAnimalesEnTiempoReal();
    suscribirTareasEnTiempoReal();
    suscribirPredioEnTiempoReal();

  } else {
    // ── OPERARIO NO AUTENTICADO ──
    usuarioActual = null;
    console.log('[Auth] ℹ️ No hay sesión activa. Mostrando pantalla de login.');

    // Cancelar todas las suscripciones
    if (desuscribirAnimales) { desuscribirAnimales(); desuscribirAnimales = null; }
    if (desuscribirTareas)   { desuscribirTareas();   desuscribirTareas = null; }
    if (desuscribirPredio)   { desuscribirPredio();   desuscribirPredio = null; }

    // Ocultar interfaz y mostrar pantalla de login
    if (vistaLogin)   vistaLogin.classList.remove('oculto');
    if (appContainer) appContainer.style.display = 'none';
    if (navbar)       navbar.style.display = 'none';
  }
});


/** @type {Function|null} Función de desuscripción del listener de Tareas en Firestore */
let desuscribirTareas = null;

/** @type {Function|null} Función de desuscripción del listener de Predio en Firestore */
let desuscribirPredio = null;

/**
 * Migra los datos que existan en LocalStorage (de la versión vieja sin login)
 * hacia Firebase Firestore. Se ejecuta una sola vez al iniciar sesión por primera vez.
 * Usa transacciones batch para asegurar la consistencia y la velocidad offline de la PWA.
 */
async function migrarDatosLocalesAFirestore() {
  if (!usuarioActual) return;

  try {
    // 1. Migrar Predio local
    const predioLocal = leerStorage(CLAVES_STORAGE.PREDIO);
    if (predioLocal && (predioLocal.objetivo || predioLocal.coordenadas)) {
      console.log('[Migración] 📦 Migrando predio local a Firestore...');
      await db.collection('predios').doc(usuarioActual.uid).set({
        ...predioLocal,
        operario_uid: usuarioActual.uid,
        operario_email: usuarioActual.email,
        fechaActualizacion: new Date().toISOString()
      }, { merge: true });
      
      // Limpiar predio local
      localStorage.removeItem(CLAVES_STORAGE.PREDIO);
      console.log('[Migración] ✅ Predio migrado con éxito.');
    }

    // 2. Migrar Inventario local (Animales)
    const inventarioLocal = leerStorage(CLAVES_STORAGE.INVENTARIO);
    if (Array.isArray(inventarioLocal) && inventarioLocal.length > 0) {
      console.log(`[Migración] 📦 Migrando ${inventarioLocal.length} animales locales a Firestore...`);
      const batch = db.batch();
      
      inventarioLocal.forEach((animal) => {
        const docRef = db.collection('animales').doc(); // Generar ID automático de Firestore
        const animalMigrado = {
          ...animal,
          operario_uid: usuarioActual.uid,
          operario_email: usuarioActual.email,
          id_anterior: animal.id || null,
          fechaModificacion: new Date().toISOString()
        };
        // Eliminar ID local redundante si tiene
        delete animalMigrado.id;
        delete animalMigrado.sincronizado; // En firestore ya está sincronizado
        
        batch.set(docRef, animalMigrado);
      });
      
      await batch.commit();
      localStorage.removeItem(CLAVES_STORAGE.INVENTARIO);
      console.log('[Migración] ✅ Inventario de animales migrado con éxito.');
    }

    // 3. Migrar Agenda local (Tareas)
    const agendaLocal = leerStorage(CLAVES_STORAGE.AGENDA);
    if (Array.isArray(agendaLocal) && agendaLocal.length > 0) {
      console.log(`[Migración] 📦 Migrando ${agendaLocal.length} tareas locales a Firestore...`);
      const batch = db.batch();
      
      agendaLocal.forEach((tarea) => {
        const docRef = db.collection('tareas').doc();
        const tareaMigrada = {
          ...tarea,
          operario_uid: usuarioActual.uid,
          operario_email: usuarioActual.email,
          id_anterior: tarea.id || null,
          fechaModificacion: new Date().toISOString()
        };
        delete tareaMigrada.id;
        delete tareaMigrada.sincronizado;
        
        batch.set(docRef, tareaMigrada);
      });
      
      await batch.commit();
      localStorage.removeItem(CLAVES_STORAGE.AGENDA);
      console.log('[Migración] ✅ Agenda de tareas migrada con éxito.');
    }
  } catch (error) {
    console.error('[Migración] ❌ Error durante la migración de datos locales:', error);
    mostrarToast('Error al migrar los datos locales a la nube.', 'error', 5000);
  }
}

/**
 * Suscribe un listener en tiempo real (onSnapshot) para el Predio del operario.
 */
function suscribirPredioEnTiempoReal() {
  if (desuscribirPredio) {
    desuscribirPredio();
  }

  if (!usuarioActual) return;

  const docRef = db.collection('predios').doc(usuarioActual.uid);

  desuscribirPredio = docRef.onSnapshot(
    (doc) => {
      if (doc.exists) {
        const predio = doc.data();
        const textoGPS = document.getElementById('texto-gps');
        const selObj   = document.getElementById('sel-objetivo');

        if (predio.coordenadas && textoGPS) {
          const c = predio.coordenadas;
          textoGPS.textContent =
            `📍 Lat: ${c.latitud.toFixed(6)} | Long: ${c.longitud.toFixed(6)} ` +
            `(±${Math.round(c.precision)}m)`;
        } else if (textoGPS) {
          textoGPS.textContent = 'Coordenadas no registradas aún.';
        }

        if (predio.objetivo && selObj) {
          selObj.value = predio.objetivo;
        }
      }
    },
    (error) => {
      console.error('[Predio] ❌ Error en onSnapshot:', error);
    }
  );
}


/**
 * Conecta el botón de login con la función de autenticación.
 * Se ejecuta apenas el DOM está listo para no perder el evento.
 */
document.addEventListener('DOMContentLoaded', () => {
  const btnLogin = document.getElementById('btn-google-login');
  if (btnLogin) {
    btnLogin.addEventListener('click', iniciarSesionConGoogle);
  }
});

/* ============================================================
   MÓDULO 1: CONSTANTES Y CLAVES DE ALMACENAMIENTO
   Define los nombres de las claves en LocalStorage.
   Centralizarlas aquí evita errores de tipeo en el código.
============================================================ */

/** @type {Object} Claves únicas para cada colección de datos en LocalStorage */
const CLAVES_STORAGE = {
  PREDIO:           'oviagro_predio',
  INVENTARIO:       'oviagro_inventario',
  HISTORIAL_SAN:    'oviagro_historial_sanitario',
  HISTORIAL_PESO:   'oviagro_historial_pesajes',
  AGENDA:           'oviagro_agenda_tareas',
  GASTOS:           'oviagro_gastos',
};


/* ============================================================
   MÓDULO 2: MOTOR DE PERSISTENCIA (LocalStorage + JSON)
   Toda operación de lectura/escritura pasa por este módulo.
   NUNCA escribir directamente localStorage fuera de aquí.
============================================================ */

/**
 * Inicializa el almacenamiento local con estructuras vacías.
 * Si ya existen datos, NO los sobreescribe.
 * Se llama una sola vez al arrancar la app.
 */
function inicializarStorage() {
  const estructurasIniciales = {
    [CLAVES_STORAGE.PREDIO]: {
      nombre:        '',
      propietario:   '',
      objetivo:      '',
      coordenadas:   null,
      fechaCreacion: new Date().toISOString(),
    },
    [CLAVES_STORAGE.INVENTARIO]:    [],
    [CLAVES_STORAGE.HISTORIAL_SAN]: [],
    [CLAVES_STORAGE.HISTORIAL_PESO]:[],
    [CLAVES_STORAGE.AGENDA]:        [],
    [CLAVES_STORAGE.GASTOS]:        [],
  };

  Object.entries(estructurasIniciales).forEach(([clave, valorInicial]) => {
    if (localStorage.getItem(clave) === null) {
      try {
        localStorage.setItem(clave, JSON.stringify(valorInicial));
        console.log(`[Storage] ✅ Clave inicializada: ${clave}`);
      } catch (error) {
        console.error(`[Storage] ❌ Error al inicializar la clave "${clave}":`, error);
      }
    }
  });
}

/**
 * Lee y parsea un ítem de LocalStorage de forma segura.
 * @param {string} clave - La clave de LocalStorage a leer.
 * @returns {*} El valor parseado, o null si hay error.
 */
function leerStorage(clave) {
  try {
    const raw = localStorage.getItem(clave);
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    console.error(`[Storage] ❌ Error al leer la clave "${clave}":`, error);
    return null;
  }
}

/**
 * Serializa y guarda un valor en LocalStorage de forma segura.
 * @param {string} clave - La clave de LocalStorage donde guardar.
 * @param {*} valor - El valor (objeto/array) a guardar como JSON.
 * @returns {boolean} true si se guardó correctamente, false si hubo error.
 */
function escribirStorage(clave, valor) {
  try {
    localStorage.setItem(clave, JSON.stringify(valor));
    return true;
  } catch (error) {
    console.error(`[Storage] ❌ Error al escribir en la clave "${clave}":`, error);
    mostrarToast('Error al guardar. ¿Quedó sin espacio el dispositivo?', 'error');
    return false;
  }
}


/* ============================================================
   MÓDULO 3: UTILIDADES DE SEGURIDAD Y VALIDACIÓN
   Sanitización de datos para prevenir inyecciones XSS.
============================================================ */

/**
 * Sanitiza un texto eliminando caracteres HTML peligrosos.
 * Previene inyecciones de código en el DOM.
 * @param {string} texto - El texto crudo ingresado por el usuario.
 * @returns {string} El texto limpio y seguro.
 */
function sanitizarTexto(texto) {
  if (typeof texto !== 'string') return '';
  return texto
    .trim()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .replace(/\//g, '&#x2F;');
}

/**
 * Genera un ID único para cada registro basado en timestamp + random.
 * @returns {string} ID único en formato string.
 */
function generarId() {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Formatea una fecha ISO a formato legible en español (Argentina).
 * @param {string} isoString - Fecha en formato ISO 8601.
 * @returns {string} Fecha formateada, ej: "26/05/2026 20:45"
 */
function formatearFecha(isoString) {
  try {
    return new Date(isoString).toLocaleString('es-AR', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return isoString;
  }
}


/* ============================================================
   MÓDULO 4: SISTEMA DE NOTIFICACIONES (Toast)
   Muestra mensajes al usuario sin interrumpir el flujo.
============================================================ */

/** @type {number|null} Timer del toast actual */
let timerToast = null;

/**
 * Muestra un mensaje de notificación temporal (Toast) al usuario.
 * @param {string} mensaje  - El texto a mostrar.
 * @param {'info'|'exito'|'error'} tipo - Tipo visual del mensaje.
 * @param {number} duracion - Milisegundos que permanece visible. Default: 3500.
 */
function mostrarToast(mensaje, tipo = 'info', duracion = 3500) {
  const toast = document.getElementById('toast');
  if (!toast) return;

  // Limpiar timer previo si hay uno activo
  if (timerToast) clearTimeout(timerToast);

  toast.textContent = mensaje;
  toast.className = `visible ${tipo}`;

  timerToast = setTimeout(() => {
    toast.className = '';
    timerToast = null;
  }, duracion);
}


/* ============================================================
   MÓDULO 5: ENRUTADOR SPA
   Gestiona la navegación entre vistas manipulando el DOM.
   NO recarga la página; solo muestra/oculta secciones HTML.
============================================================ */

/** @type {string} Vista actualmente visible */
let vistaActual = 'inicio';

/**
 * Navega a una vista específica de la SPA.
 * Oculta la vista anterior y muestra la nueva.
 * @param {string} nombreVista - Identificador de la vista ('inicio', 'alta', 'inventario').
 */
function navegarA(nombreVista) {
  // Ocultar todas las vistas
  document.querySelectorAll('.vista').forEach((vista) => {
    vista.classList.remove('activa');
  });

  // Mostrar la vista solicitada
  const vistaNueva = document.getElementById(`vista-${nombreVista}`);
  if (!vistaNueva) {
    console.error(`[Router] ❌ Vista no encontrada: vista-${nombreVista}`);
    return;
  }
  vistaNueva.classList.add('activa');

  // Actualizar estado de los botones de la navbar
  document.querySelectorAll('.nav-btn').forEach((btn) => {
    const estaActivo = btn.dataset.vista === nombreVista;
    btn.classList.toggle('activo', estaActivo);
    btn.setAttribute('aria-current', estaActivo ? 'page' : 'false');
  });

  vistaActual = nombreVista;

  // Si navegamos al inventario, actualizamos la lista automáticamente
  if (nombreVista === 'inventario') {
    listarAnimalesLocales();
  }

  // Si navegamos al inicio, cargamos datos guardados del predio
  if (nombreVista === 'inicio') {
    cargarDatosPredio();
    actualizarAlertasInicio();
  }

  // Si navegamos a la tarea, actualizamos la lista automáticamente
  if (nombreVista === 'tarea') {
    listarAgendaLocal();
  }

  // Si navegamos a Salud, limpiamos el historial rápido para evitar
  // mostrar datos residuales de una consulta anterior
  if (nombreVista === 'salud') {
    const historialRapido = document.getElementById('historial-sanitarios-rapido');
    if (historialRapido) historialRapido.innerHTML = '';
  }

  console.log(`[Router] ✅ Navegando a: ${nombreVista}`);
}

/**
 * Inicializa el enrutador conectando los botones de la navbar.
 * Llama a navegarA() cuando el usuario toca un botón.
 */
function inicializarRouter() {
  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const vista = btn.dataset.vista;
      if (vista && vista !== vistaActual) {
        navegarA(vista);
      }
    });
  });

  // Mostrar la vista inicial al cargar
  navegarA('inicio');
  console.log('[Router] ✅ Enrutador SPA inicializado.');
}


/* ============================================================
   MÓDULO 6: LÓGICA DE NEGOCIO — PREDIO
   Gestión de los datos de la explotación agropecuaria.
============================================================ */

/**
 * Captura las coordenadas GPS del dispositivo usando la Geolocation API.
 * Si el usuario acepta, guarda las coordenadas en el predio de Firestore.
 */
function capturarGPS() {
  const btnGPS   = document.getElementById('btn-capturar-gps');
  const textoGPS = document.getElementById('texto-gps');

  if (!navigator.geolocation) {
    mostrarToast('Este dispositivo no soporta GPS.', 'error');
    return;
  }

  if (!usuarioActual) {
    mostrarToast('Sesión no iniciada.', 'error');
    return;
  }

  // Feedback visual durante la captura
  btnGPS.disabled  = true;
  textoGPS.textContent = '📡 Buscando señal GPS... Aguardá.';

  navigator.geolocation.getCurrentPosition(
    // ÉXITO: coordenadas obtenidas
    async (posicion) => {
      const coords = {
        latitud:  posicion.coords.latitude,
        longitud: posicion.coords.longitude,
        precision: posicion.coords.accuracy,
        timestamp: new Date().toISOString(),
      };

      try {
        await db.collection('predios').doc(usuarioActual.uid).set({
          operario_uid: usuarioActual.uid,
          operario_email: usuarioActual.email,
          coordenadas: coords,
          fechaActualizacion: new Date().toISOString()
        }, { merge: true });

        btnGPS.disabled = false;
        mostrarToast('✅ Coordenadas GPS guardadas correctamente.', 'exito');
        console.log('[GPS] ✅ Coordenadas guardadas en Firestore:', coords);
      } catch (error) {
        console.error('[GPS] ❌ Error al guardar coordenadas en Firestore:', error);
        btnGPS.disabled = false;
        mostrarToast('Error al guardar GPS en la nube.', 'error');
      }
    },
    // ERROR: no se pudieron obtener las coordenadas
    (errorGeo) => {
      const mensajes = {
        1: 'Permiso de ubicación denegado. Habilitalo en la configuración.',
        2: 'No se pudo determinar la ubicación. Sin señal GPS.',
        3: 'Tiempo de espera agotado. Intentá al aire libre.',
      };
      const msg = mensajes[errorGeo.code] || 'Error desconocido al obtener GPS.';
      textoGPS.textContent = `⚠️ ${msg}`;
      btnGPS.disabled = false;
      mostrarToast(msg, 'error', 5000);
      console.warn('[GPS] ⚠️ Error de geolocalización:', errorGeo);
    },
    // Opciones de precisión
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
  );
}

/**
 * Guarda el objetivo productivo seleccionado en el predio de Firestore.
 */
async function guardarDatosPredio() {
  const objetivo = document.getElementById('sel-objetivo')?.value || '';

  if (!objetivo) {
    mostrarToast('Seleccioná un objetivo productivo antes de guardar.', 'error');
    return;
  }

  if (!usuarioActual) {
    mostrarToast('Sesión no iniciada.', 'error');
    return;
  }

  try {
    await db.collection('predios').doc(usuarioActual.uid).set({
      operario_uid: usuarioActual.uid,
      operario_email: usuarioActual.email,
      objetivo: sanitizarTexto(objetivo),
      fechaActualizacion: new Date().toISOString()
    }, { merge: true });

    mostrarToast('✅ Datos del predio guardados.', 'exito');
  } catch (error) {
    console.error('[Predio] ❌ Error al guardar datos en Firestore:', error);
    mostrarToast('Error al guardar en la nube.', 'error');
  }
}

/**
 * Carga los datos del predio. Obsoleto al usar onSnapshot en tiempo real.
 */
function cargarDatosPredio() {
  // Manejado en tiempo real por suscribirPredioEnTiempoReal()
}


/* ============================================================
   MÓDULO 7: LÓGICA DE NEGOCIO — INVENTARIO ANIMAL (FIRESTORE)
   Las funciones de guardado y listado ahora usan Firebase Firestore
   en lugar de LocalStorage. La foto se guarda como Base64 en el doc.
============================================================ */

/**
 * Valida, sanitiza y guarda un nuevo animal en la colección 'animales'
 * de Firestore. La foto (convertida a Base64 por canvas) se guarda como
 * campo de texto 'foto' dentro del mismo documento de Firestore.
 * El campo 'operario_uid' vincula el registro al usuario autenticado.
 *
 * @param {Object} nuevoAnimal - Datos crudos del formulario.
 * @returns {Promise<boolean>} true si se guardó correctamente.
 */
async function guardarAnimalLocal(nuevoAnimal) {
  if (!nuevoAnimal || typeof nuevoAnimal !== 'object') {
    mostrarToast('Error interno: datos del animal inválidos.', 'error');
    return false;
  }

  let { caravana, nombre, sexo, raza, categoria, fecha_nac, peso_nac, madre, padre, castrado, foto } = nuevoAnimal;

  if (!caravana || caravana.trim() === '') {
    mostrarToast('⚠️ El número de caravana es obligatorio.', 'error');
    document.getElementById('input-caravana')?.focus();
    return false;
  }

  if (!sexo) {
    mostrarToast('⚠️ Seleccioná el sexo del animal.', 'error');
    return false;
  }

  if (!raza) {
    mostrarToast('⚠️ Seleccioná una raza.', 'error');
    document.getElementById('sel-raza')?.focus();
    return false;
  }

  if (!categoria) {
    mostrarToast('⚠️ Seleccioná la categoría por dentición.', 'error');
    document.getElementById('sel-categoria')?.focus();
    return false;
  }

  // Verificar que haya un operario autenticado antes de guardar
  if (!usuarioActual) {
    mostrarToast('Sesión no iniciada. Recargá la app.', 'error');
    return false;
  }

  try {
    const caravanaLimpia = caravana.trim().toUpperCase();

    // Verificar duplicado consultando Firestore por este operario
    const duplicadoSnap = await db.collection('animales')
      .where('operario_uid', '==', usuarioActual.uid)
      .where('caravana_id', '==', caravanaLimpia)
      .limit(1)
      .get();

    if (!duplicadoSnap.empty) {
      mostrarToast(`❌ La caravana "${caravanaLimpia}" ya existe en el inventario.`, 'error', 5000);
      document.getElementById('input-caravana')?.focus();
      return false;
    }

    // Normalizar campos opcionales vacíos a null
    nombre    = nombre?.trim()  ? sanitizarTexto(nombre)              : null;
    fecha_nac = fecha_nac       ? fecha_nac                           : null;
    peso_nac  = peso_nac        ? parseFloat(peso_nac)                : null;
    madre     = madre?.trim()   ? sanitizarTexto(madre.toUpperCase()) : null;
    padre     = padre?.trim()   ? sanitizarTexto(padre.toUpperCase()) : null;
    // La foto viene como cadena Base64 del procesador de canvas.
    // Se guarda como campo de texto directamente en Firestore (sin Storage).
    foto      = foto            ? foto                                : null;

    const animalSanitizado = {
      operario_uid:     usuarioActual.uid,          // Vincula el animal al operario
      operario_email:   usuarioActual.email,         // Email del operario (auditoría)
      caravana_id:      sanitizarTexto(caravanaLimpia),
      nombre:           nombre,
      sexo:             sanitizarTexto(sexo),
      raza:             sanitizarTexto(raza),
      categoria:        sanitizarTexto(categoria),
      fecha_nacimiento: fecha_nac,
      peso_nacimiento:  peso_nac,
      caravana_madre:   madre,
      caravana_padre:   padre,
      castrado:         Boolean(castrado),
      foto:             foto,                        // String Base64 directo
      historial_sanitario:           [],
      historial_nutricional_pesajes: [],
      fechaAlta:         new Date().toISOString(),
      fechaModificacion: new Date().toISOString(),
    };

    // Guardar el documento en Firestore (ID automático con .add())
    await db.collection('animales').add(animalSanitizado);

    console.log(`[Inventario] ✅ Animal guardado en Firestore: ${animalSanitizado.caravana_id}`);
    mostrarToast(`✅ Caravana ${animalSanitizado.caravana_id} registrada con éxito.`, 'exito');
    return true;

  } catch (error) {
    console.error('[Inventario] ❌ Error inesperado al guardar animal en Firestore:', error);
    mostrarToast('Error al guardar. Verificá tu conexión e intentá de nuevo.', 'error');
    return false;
  }
}

/**
 * Suscribe un listener en tiempo real (onSnapshot) a la colección 'animales'
 * de Firestore, filtrada por el UID del operario autenticado.
 *
 * Cuando los datos cambian en la nube (o se sincronizan desde la caché offline),
 * el callback se dispara automáticamente y actualiza la interfaz sin recargar.
 * La referencia de desuscripción se guarda en 'desuscribirAnimales'.
 */
function suscribirAnimalesEnTiempoReal() {
  listarAnimalesLocales();
}

/**
 * Renderiza las tarjetas del inventario en el DOM.
 * Es llamada automáticamente por el listener onSnapshot.
 * @param {Array} inventario - Array de objetos animal desde Firestore.
 */
function renderizarInventario(inventario) {
  const contenedor = document.getElementById('lista-animales');
  const contadorEl = document.getElementById('inventario-contador');
  if (!contenedor) return;

  if (contadorEl) {
    contadorEl.innerHTML = inventario.length > 0
      ? `<span>${inventario.length}</span> animal${inventario.length !== 1 ? 'es' : ''} registrado${inventario.length !== 1 ? 's' : ''}`
      : '';
  }

  if (inventario.length === 0) {
    contenedor.innerHTML = `
      <div class="inventario-vacio" role="status">
        <span class="vacio-icono" aria-hidden="true">🐑</span>
        <p>No hay animales registrados todavía.<br>
        Usá <strong>Alta Animal</strong> para agregar el primero.</p>
      </div>`;
    return;
  }

  const htmlTarjetas = inventario.map((animal) => {
    const iconoSexo     = animal.sexo === 'Macho' ? '♂️' : '♀️';
    const iconoFoto     = animal.foto ? ' 📷' : '';
    const textoCastrado = animal.castrado ? ' (Castrado)' : '';

    let badgeRetiro = '';
    if (animal.fecha_limite_carencia) {
      const ahora       = new Date();
      const fechaRetiro = new Date(animal.fecha_limite_carencia);
      if (ahora < fechaRetiro) {
        const fechaFmt = fechaRetiro.toLocaleDateString('es-AR', {
          day: '2-digit', month: '2-digit', year: 'numeric'
        });
        badgeRetiro = `<div class="badge-retiro" role="alert">⚠️ RETIRO ACTIVO — No vender hasta ${fechaFmt}</div>`;
      }
    }

    return `
      <article class="animal-tarjeta" role="listitem" aria-label="Animal caravana ${animal.caravana_id}">
        <p class="animal-caravana">${animal.caravana_id}${iconoFoto}</p>
        <div class="animal-detalles">
          ${animal.nombre ? `<strong>Nombre:</strong> ${animal.nombre}<br>` : ''}
          <strong>Sexo:</strong> ${iconoSexo} ${animal.sexo}${textoCastrado}<br>
          <strong>Raza:</strong> ${animal.raza}<br>
          <strong>Categoría:</strong> ${animal.categoria}<br>
        </div>
        ${badgeRetiro}
        <p class="animal-fecha">Alta: ${formatearFecha(animal.fechaAlta)}</p>
      </article>`;
  }).join('');

  contenedor.innerHTML = htmlTarjetas;
}

/**
 * Se suscribe en tiempo real a los animales en Firestore de forma segura.
 * Si no hay animales (snapshot.empty === true), muestra el estado vacío sin errores.
 * Solo usa console.error() para errores reales de red o permisos.
 * Ordenamiento por fecha hecho en cliente para evitar errores de índice en BD nueva.
 */
function listarAnimalesLocales() {
  if (desuscribirAnimales) {
    return; // Ya existe una suscripción activa, no crear otra
  }

  if (!usuarioActual) {
    console.warn('[Inventario] ⚠️ No hay operario autenticado.');
    return;
  }

  try {
    // Consulta SIN orderBy para evitar requerir un índice compuesto en Firestore.
    // El ordenamiento se aplica en el cliente, lo que es correcto para un inventario de campo.
    const consulta = db.collection('animales')
      .where('operario_uid', '==', usuarioActual.uid);

    desuscribirAnimales = consulta.onSnapshot(
      (snapshot) => {
        try {
          if (!snapshot || snapshot.empty) {
            // Estado completamente normal: base de datos vacía o sin animales para este usuario
            console.log('[Inventario] ℹ️ Sin animales registrados para este operario.');
            renderizarInventario([]);
            return;
          }
          // Mapear documentos y ordenar por fechaAlta descendente en el cliente
          const inventario = snapshot.docs
            .map((doc) => ({ id: doc.id, ...doc.data() }))
            .sort((a, b) => {
              const fa = a.fechaAlta ? new Date(a.fechaAlta) : new Date(0);
              const fb = b.fechaAlta ? new Date(b.fechaAlta) : new Date(0);
              return fb - fa;
            });
          renderizarInventario(inventario);
          console.log(`[Inventario] ✅ onSnapshot: ${inventario.length} animales.`);
        } catch (innerErr) {
          console.error('[Inventario] ❌ Error procesando snapshot de animales:', innerErr);
        }
      },
      (error) => {
        // Error real (permisos, red) — solo en consola, nunca interrumpe al usuario
        console.error('[Inventario] ❌ Error Firestore en animales:', error);
        renderizarInventario([]);
      }
    );
  } catch (err) {
    console.error('[Inventario] ❌ Error al inicializar suscripción de animales:', err);
  }
}


/* ============================================================
   MÓDULO 8: CONTROLADORES DE FORMULARIO
   Conectan la UI (eventos del DOM) con la lógica de negocio.
============================================================ */

/** @type {string|null} Imagen procesada temporalmente en Base64 */
let fotoBase64Temporal = null;

/**
 * Procesa la imagen seleccionada: la dibuja en Canvas, la redimensiona y la comprime.
 */
function inicializarProcesadorFoto() {
  const inputFoto = document.getElementById('foto-animal');
  const contenedorPrevia = document.getElementById('previsualizacion-foto');

  if (!inputFoto || !contenedorPrevia) return;

  inputFoto.addEventListener('change', (evento) => {
    const archivo = evento.target.files[0];
    if (!archivo) {
      fotoBase64Temporal = null;
      contenedorPrevia.innerHTML = '';
      contenedorPrevia.classList.remove('activo');

      return;
    }

    const lector = new FileReader();
    lector.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const MAX_WIDTH = 450;
        let width = img.width;
        let height = img.height;

        if (width > MAX_WIDTH) {
          height = Math.round((height * MAX_WIDTH) / width);
          width = MAX_WIDTH;
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);

        fotoBase64Temporal = canvas.toDataURL('image/jpeg', 0.6);

        contenedorPrevia.innerHTML = `<img src="${fotoBase64Temporal}" alt="Previsualización de la foto">`;
        contenedorPrevia.classList.add('activo');
      };
      img.src = e.target.result;
    };
    lector.readAsDataURL(archivo);
  });
}

/**
 * Inicializa los listeners del formulario de Alta de Animal.
 * Recoge los datos del formulario y llama a guardarAnimalLocal().
 */
function inicializarFormularioAlta() {
  inicializarProcesadorFoto();

  const btn = document.getElementById('btn-guardar-animal');
  if (!btn) return;

  btn.addEventListener('click', async () => {
    let sexoSeleccionado = '';
    const radiosSexo = document.getElementsByName('sexo');
    for (const r of radiosSexo) {
      if (r.checked) {
        sexoSeleccionado = r.value;
        break;
      }
    }

    const datosFormulario = {
      caravana:      document.getElementById('input-caravana')?.value   || '',
      nombre:        document.getElementById('input-nombre')?.value     || '',
      sexo:          sexoSeleccionado,
      raza:          document.getElementById('sel-raza')?.value         || '',
      categoria:     document.getElementById('sel-categoria')?.value    || '',
      fecha_nac:     document.getElementById('input-fecha-nac')?.value  || '',
      peso_nac:      document.getElementById('input-peso-nac')?.value   || '',
      madre:         document.getElementById('input-madre')?.value      || '',
      padre:         document.getElementById('input-padre')?.value      || '',
      castrado:      document.getElementById('checkbox-castrado')?.checked || false,
      foto:          fotoBase64Temporal
    };

    // Llamada asíncrona: guardarAnimalLocal ahora guarda en Firestore (await)
    const guardadoOk = await guardarAnimalLocal(datosFormulario);

    if (guardadoOk) {
      limpiarFormularioAlta();
    }
  });
}

/**
 * Limpia todos los campos del formulario de Alta de Animal
 * después de un guardado exitoso.
 */
function limpiarFormularioAlta() {
  const camposInput = ['input-caravana', 'input-nombre', 'input-fecha-nac', 'input-peso-nac', 'input-madre', 'input-padre'];
  camposInput.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });

  const camposSelect = ['sel-raza', 'sel-categoria'];
  camposSelect.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });

  const radiosSexo = document.getElementsByName('sexo');
  radiosSexo.forEach(r => r.checked = false);

  const checkboxCastrado = document.getElementById('checkbox-castrado');
  if (checkboxCastrado) checkboxCastrado.checked = false;

  const inputFoto = document.getElementById('foto-animal');
  if (inputFoto) inputFoto.value = '';
  
  fotoBase64Temporal = null;
  const contenedorPrevia = document.getElementById('previsualizacion-foto');
  if (contenedorPrevia) {
    contenedorPrevia.innerHTML = '';
    contenedorPrevia.classList.remove('activo');
  }

  document.getElementById('input-caravana')?.focus();
}

/**
 * Inicializa los listeners de la vista Inicio.
 */
function inicializarVistaInicio() {
  document.getElementById('btn-capturar-gps')
    ?.addEventListener('click', capturarGPS);

  document.getElementById('btn-guardar-predio')
    ?.addEventListener('click', guardarDatosPredio);

  // Configurar el botón de instalación PWA
  const btnInstalar = document.getElementById('btn-instalar-pwa');
  if (btnInstalar) {
    btnInstalar.addEventListener('click', async () => {
      if (!deferredPrompt) return;

      try {
        // Mostrar el prompt nativo de instalación
        deferredPrompt.prompt();

        // Esperar la elección del usuario
        const { outcome } = await deferredPrompt.userChoice;
        console.log(`[PWA] Elección de instalación del usuario: ${outcome}`);
      } catch (err) {
        console.error('[PWA] ❌ Error en el prompt de instalación:', err);
      } finally {
        // Ocultar el botón e invalidar el evento diferido
        btnInstalar.style.display = 'none';
        deferredPrompt = null;
      }
    });

    // Si por alguna razón el prompt se disparó antes de inicializar la vista,
    // y deferredPrompt ya está seteado, mostramos el botón de inmediato.
    if (deferredPrompt) {
      btnInstalar.style.display = 'block';
    }
  }
}


/* ============================================================
   MÓDULO 9: LÓGICA DE NEGOCIO — SANIDAD ANIMAL
   Gestiona vacunaciones, desparasitaciones y tratamientos.
   Soporta registros Individuales (por caravana) y Por Lote
   (todos los animales de una categoría), con cálculo de
   período de carencia y puntuación Famacha interactiva.
============================================================ */

/**
 * Variables de estado del módulo sanitario.
 * Se actualizan cuando el usuario toca los botones selectores.
 */
let tipoRegistroSalud = 'individual'; // 'individual' | 'lote'
let tipoEventoSalud   = null;         // 'Vacunación' | 'Desparasitación' | 'Tratamiento Enfermedad'
let viaAdminSalud     = null;         // 'Subcutánea' | 'Intramuscular' | 'Oral' | 'Tópica'
let puntajeFamacha    = null;         // Número del 1 al 5

/**
 * Guarda un registro sanitario en el inventario local (LocalStorage).
 *
 * Flujo:
 *   1. Recoger y validar campos obligatorios.
 *   2. Construir el objeto de registro con todos los campos.
 *   3a. INDIVIDUAL: buscar el animal por caravana, empujar al historial.
 *   3b. POR LOTE: iterar inventario, aplicar a todos los de la categoría.
 *   4. Persistir el inventario actualizado en LocalStorage.
 *   5. Mostrar feedback y limpiar el formulario.
 */
async function guardarRegistroSanitario() {
  if (!usuarioActual) {
    mostrarToast('Sesión no iniciada. Recargá la app.', 'error');
    return;
  }

  try {
    // --- 1. Recoger valores del formulario ---
    const producto     = document.getElementById('input-producto-salud')?.value?.trim() || '';
    const dosis        = document.getElementById('input-dosis-salud')?.value?.trim()    || '';
    const diasCarenciaRaw = parseInt(document.getElementById('input-carencia-salud')?.value) || 0;
    const observaciones = document.getElementById('input-obs-salud')?.value?.trim()     || '';

    // --- 2. Validaciones de campos obligatorios ---
    if (!tipoEventoSalud) {
      mostrarToast('⚠️ Seleccioná el tipo de evento (vacunación, desparasitación, etc.).', 'error');
      return;
    }
    if (!producto) {
      mostrarToast('⚠️ El nombre del producto o medicamento es obligatorio.', 'error');
      document.getElementById('input-producto-salud')?.focus();
      return;
    }
    if (!dosis) {
      mostrarToast('⚠️ La dosis aplicada es obligatoria.', 'error');
      document.getElementById('input-dosis-salud')?.focus();
      return;
    }

    // --- 3. Calcular fecha de carencia si corresponde ---
    const ahora = new Date();
    let fechaLimiteCarencia = null;

    if (diasCarenciaRaw > 0) {
      // Suma los días de retiro a la fecha actual para obtener la fecha límite
      const fechaRetiro = new Date(ahora);
      fechaRetiro.setDate(fechaRetiro.getDate() + diasCarenciaRaw);
      fechaLimiteCarencia = fechaRetiro.toISOString();
    }

    // --- 4. Construir el objeto del registro sanitario ---
    const registro = {
      id:                    generarId(),
      fecha:                 ahora.toISOString(),
      tipo_evento:           sanitizarTexto(tipoEventoSalud),
      producto:              sanitizarTexto(producto),
      dosis:                 sanitizarTexto(dosis),
      via_administracion:    viaAdminSalud     ? sanitizarTexto(viaAdminSalud)     : null,
      famacha:               puntajeFamacha,   // null si no se seleccionó
      dias_carencia:         diasCarenciaRaw   > 0 ? diasCarenciaRaw               : null,
      fecha_limite_carencia: fechaLimiteCarencia,
      observaciones:         observaciones     ? sanitizarTexto(observaciones)     : null,
    };

    if (tipoRegistroSalud === 'individual') {
      // ── MODO INDIVIDUAL: buscar el animal por número de caravana en Firestore ──
      const caravanaRaw = document.getElementById('input-caravana-salud')?.value?.trim() || '';
      if (!caravanaRaw) {
        mostrarToast('⚠️ Ingresá el Nº de caravana del animal.', 'error');
        document.getElementById('input-caravana-salud')?.focus();
        return;
      }
      const caravana = caravanaRaw.toUpperCase();

      // Buscar el animal en Firestore para el operario actual
      const snap = await db.collection('animales')
        .where('operario_uid', '==', usuarioActual.uid)
        .where('caravana_id', '==', caravana)
        .limit(1)
        .get();

      if (snap.empty) {
        mostrarToast(`❌ Caravana "${caravana}" no encontrada en el inventario.`, 'error', 5000);
        document.getElementById('input-caravana-salud')?.focus();
        return;
      }

      const doc = snap.docs[0];
      const animal = doc.data();

      // Garantizar que el array historial existe antes de empujar
      if (!Array.isArray(animal.historial_sanitario)) {
        animal.historial_sanitario = [];
      }
      animal.historial_sanitario.push(registro);

      // Si hay carencia, actualizar la fecha en el animal
      if (fechaLimiteCarencia) {
        animal.fecha_limite_carencia = fechaLimiteCarencia;
      }
      animal.fechaModificacion = ahora.toISOString();

      // Actualizar el documento en Firestore
      await db.collection('animales').doc(doc.id).update({
        historial_sanitario:   animal.historial_sanitario,
        fecha_limite_carencia: animal.fecha_limite_carencia || null,
        fechaModificacion:     animal.fechaModificacion
      });

      mostrarToast(`✅ Registro sanitario guardado para ${caravana}.`, 'exito');
      console.log(`[Sanidad] ✅ Registro individual en Firestore → ${caravana}`, registro);

      // Mostrar historial rápido del animal en el mismo formulario
      mostrarHistorialRapido(animal);

    } else {
      // ── MODO POR LOTE: aplicar a todos los animales de la categoría en Firestore ──
      const categoriaLote = document.getElementById('sel-categoria-salud')?.value || '';
      if (!categoriaLote) {
        mostrarToast('⚠️ Seleccioná una categoría para el lote.', 'error');
        return;
      }

      const snap = await db.collection('animales')
        .where('operario_uid', '==', usuarioActual.uid)
        .where('categoria', '==', categoriaLote)
        .get();

      if (snap.empty) {
        mostrarToast('⚠️ No hay animales registrados en esa categoría.', 'error', 5000);
        return;
      }

      const batch = db.batch();
      let contadorAfectados = 0;

      snap.docs.forEach((doc) => {
        const animal = doc.data();
        if (!Array.isArray(animal.historial_sanitario)) {
          animal.historial_sanitario = [];
        }
        // Cada animal recibe su propia copia con ID único
        const copiaRegistro = { ...registro, id: generarId() };
        animal.historial_sanitario.push(copiaRegistro);

        const camposActualizar = {
          historial_sanitario: animal.historial_sanitario,
          fechaModificacion: ahora.toISOString()
        };

        if (fechaLimiteCarencia) {
          camposActualizar.fecha_limite_carencia = fechaLimiteCarencia;
        }

        batch.update(doc.ref, camposActualizar);
        contadorAfectados++;
      });

      await batch.commit();

      const pluralAnimal = contadorAfectados !== 1 ? 'animales' : 'animal';
      mostrarToast(
        `✅ Registro aplicado a ${contadorAfectados} ${pluralAnimal} del lote.`,
        'exito', 5000
      );
      console.log(`[Sanidad] ✅ Registro por lote en Firestore → ${categoriaLote} (${contadorAfectados} animales)`, registro);

      // Mostrar confirmación en el historial rápido
      const contenedorHistorial = document.getElementById('historial-sanitarios-rapido');
      if (contenedorHistorial) {
        contenedorHistorial.innerHTML = `
          <p class="historial-vacio">
            ✅ Registro aplicado exitosamente a <strong>${contadorAfectados} ${pluralAnimal}</strong>
            de la categoría seleccionada.
          </p>`;
      }
    }

    // Limpiar formulario tras guardado exitoso
    limpiarFormularioSalud();

  } catch (error) {
    console.error('[Sanidad] ❌ Error al guardar registro sanitario en Firestore:', error);
    mostrarToast('Error al guardar en la nube. Verificá tu conexión.', 'error');
  }
}

/**
 * Renderiza las últimas 5 intervenciones del historial sanitario
 * de un animal en el contenedor de consulta rápida (#historial-sanitarios-rapido).
 *
 * @param {Object} animal - El objeto animal completo del inventario.
 */
function mostrarHistorialRapido(animal) {
  const contenedor = document.getElementById('historial-sanitarios-rapido');
  if (!contenedor) return;

  try {
    const historial = Array.isArray(animal.historial_sanitario)
      ? animal.historial_sanitario
      : [];

    if (historial.length === 0) {
      contenedor.innerHTML = `
        <p class="historial-vacio">
          Sin registros sanitarios previos para <strong>${animal.caravana_id}</strong>.
        </p>`;
      return;
    }

    // Mostrar hasta los últimos 5, del más reciente al más antiguo
    const ultimos = [...historial].reverse().slice(0, 5);

    const html = `
      <p class="historial-rapido-titulo">📋 Últimas intervenciones — ${animal.caravana_id}</p>
      ${ultimos.map((reg) => {
        const tieneCarencia    = reg.fecha_limite_carencia ? true : false;
        const claseAlerta      = tieneCarencia ? 'alerta-carencia' : '';
        const viaTexto         = reg.via_administracion ? ` | Vía: ${reg.via_administracion}` : '';
        const famachaTexto     = reg.famacha             ? ` | Famacha: ${reg.famacha}` : '';
        const carenciaTexto    = tieneCarencia
          ? `<br>⚠️ Retiro hasta: <strong>${formatearFecha(reg.fecha_limite_carencia)}</strong>`
          : '';
        const obsTexto         = reg.observaciones
          ? `<br>📝 ${reg.observaciones}`
          : '';

        return `
          <div class="historial-item ${claseAlerta}" role="listitem">
            <strong>${reg.tipo_evento}</strong> — ${reg.producto} (${reg.dosis})
            ${viaTexto}${famachaTexto}
            ${obsTexto}
            ${carenciaTexto}
            <p class="historial-fecha">Fecha: ${formatearFecha(reg.fecha)}</p>
          </div>`;
      }).join('')}`;

    contenedor.innerHTML = html;

  } catch (error) {
    console.error('[Sanidad] ❌ Error al mostrar historial rápido:', error);
  }
}

/**
 * Limpia y resetea todos los campos del formulario de Salud
 * después de un guardado exitoso, incluyendo los estados internos.
 */
function limpiarFormularioSalud() {
  // Limpiar inputs de texto y numéricos
  ['input-caravana-salud', 'input-producto-salud', 'input-dosis-salud',
   'input-carencia-salud', 'input-obs-salud'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });

  // Limpiar selector de categoría de lote
  const selCat = document.getElementById('sel-categoria-salud');
  if (selCat) selCat.value = '';

  // Ocultar el display de carencia
  const carenciaDisplay = document.getElementById('carencia-display');
  if (carenciaDisplay) {
    carenciaDisplay.textContent = '';
    carenciaDisplay.classList.remove('visible');
  }

  // Resetear botones de evento (quitar selección visual)
  document.querySelectorAll('#btn-ev-vacuna, #btn-ev-desparasitacion, #btn-ev-tratamiento')
    .forEach((btn) => {
      btn.classList.remove('seleccionado');
      btn.setAttribute('aria-pressed', 'false');
    });
  tipoEventoSalud = null;

  // Resetear botones de vía de administración
  document.querySelectorAll('#grupo-via .btn-selector').forEach((btn) => {
    btn.classList.remove('seleccionado');
    btn.setAttribute('aria-pressed', 'false');
  });
  viaAdminSalud = null;

  // Resetear cuadrícula Famacha
  document.querySelectorAll('#famacha-grid .famacha-bloque').forEach((bloque) => {
    bloque.classList.remove('seleccionado');
    bloque.setAttribute('aria-pressed', 'false');
  });
  puntajeFamacha = null;
}

/**
 * Inicializa todos los eventos interactivos del módulo de Salud.
 * Conecta:
 *   - Botones de tipo de registro (Individual / Por Lote)
 *   - Botones de tipo de evento
 *   - Botones de vía de administración
 *   - Bloques Famacha
 *   - Cálculo en tiempo real de fecha de carencia
 *   - Botón de guardado
 */
function inicializarModuloSalud() {

  // ── Selector: Individual vs Por Lote ──
  // Al tocar un botón, se actualiza tipoRegistroSalud y
  // se alterna la visibilidad de los campos dinámicos.
  document.querySelectorAll('[data-tipo]').forEach((btn) => {
    btn.addEventListener('click', () => {
      tipoRegistroSalud = btn.dataset.tipo;

      // Marcar visualmente el botón activo
      document.querySelectorAll('[data-tipo]').forEach((b) => {
        b.classList.remove('seleccionado');
        b.setAttribute('aria-pressed', 'false');
      });
      btn.classList.add('seleccionado');
      btn.setAttribute('aria-pressed', 'true');

      // Mostrar el campo correspondiente y ocultar el otro
      const campoCaravana = document.getElementById('campo-caravana-salud');
      const campoLote     = document.getElementById('campo-lote-salud');
      if (tipoRegistroSalud === 'individual') {
        campoCaravana?.classList.add('visible');
        campoLote?.classList.remove('visible');
      } else {
        campoCaravana?.classList.remove('visible');
        campoLote?.classList.add('visible');
      }
    });
  });

  // ── Selector: Tipo de Evento ──
  // Solo uno puede estar activo a la vez.
  document.querySelectorAll('[data-evento]').forEach((btn) => {
    btn.addEventListener('click', () => {
      tipoEventoSalud = btn.dataset.evento;

      document.querySelectorAll('[data-evento]').forEach((b) => {
        b.classList.remove('seleccionado');
        b.setAttribute('aria-pressed', 'false');
      });
      btn.classList.add('seleccionado');
      btn.setAttribute('aria-pressed', 'true');
    });
  });

  // ── Selector: Vía de Administración ──
  document.querySelectorAll('[data-via]').forEach((btn) => {
    btn.addEventListener('click', () => {
      viaAdminSalud = btn.dataset.via;

      document.querySelectorAll('[data-via]').forEach((b) => {
        b.classList.remove('seleccionado');
        b.setAttribute('aria-pressed', 'false');
      });
      btn.classList.add('seleccionado');
      btn.setAttribute('aria-pressed', 'true');
    });
  });

  // ── Cuadrícula Famacha: clic y teclado ──
  // Cada bloque funciona como un toggle: si ya está seleccionado, se deselecciona.
  document.querySelectorAll('#famacha-grid .famacha-bloque').forEach((bloque) => {
    const activar = () => {
      const score = parseInt(bloque.dataset.score);

      if (puntajeFamacha === score) {
        // Toggle: deseleccionar si se toca el mismo bloque
        puntajeFamacha = null;
        bloque.classList.remove('seleccionado');
        bloque.setAttribute('aria-pressed', 'false');
      } else {
        // Seleccionar nuevo bloque
        puntajeFamacha = score;
        document.querySelectorAll('#famacha-grid .famacha-bloque').forEach((b) => {
          b.classList.remove('seleccionado');
          b.setAttribute('aria-pressed', 'false');
        });
        bloque.classList.add('seleccionado');
        bloque.setAttribute('aria-pressed', 'true');
      }
    };

    bloque.addEventListener('click', activar);
    // Accesibilidad: activar con tecla Enter o Espacio
    bloque.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activar(); }
    });
  });

  // ── Cálculo en tiempo real de fecha de carencia ──
  // Cada vez que el usuario modifica el campo de días, se calcula
  // y muestra la fecha límite de retiro.
  const inputCarencia    = document.getElementById('input-carencia-salud');
  const carenciaDisplay  = document.getElementById('carencia-display');

  if (inputCarencia && carenciaDisplay) {
    inputCarencia.addEventListener('input', () => {
      const dias = parseInt(inputCarencia.value) || 0;

      if (dias > 0) {
        // Calcular fecha de vencimiento sumando los días a hoy
        const fechaVenc = new Date();
        fechaVenc.setDate(fechaVenc.getDate() + dias);
        const fechaFormateada = fechaVenc.toLocaleDateString('es-AR', {
          weekday: 'long', day: '2-digit', month: 'long', year: 'numeric',
        });
        carenciaDisplay.textContent =
          `⚠️ Retiro hasta el: ${fechaFormateada}`;
        carenciaDisplay.classList.add('visible');
      } else {
        // Ocultar el display si no hay días válidos
        carenciaDisplay.textContent = '';
        carenciaDisplay.classList.remove('visible');
      }
    });
  }

  // ── Consulta rápida de historial al escribir caravana ──
  const inputCaravanaSalud = document.getElementById('input-caravana-salud');
  if (inputCaravanaSalud) {
    const buscarHistorial = async () => {
      const caravanaRaw = inputCaravanaSalud.value?.trim() || '';
      const contenedorHistorial = document.getElementById('historial-sanitarios-rapido');
      if (!contenedorHistorial) return;

      if (!caravanaRaw) {
        contenedorHistorial.innerHTML = '';
        return;
      }

      if (!usuarioActual) return;

      try {
        const snap = await db.collection('animales')
          .where('operario_uid', '==', usuarioActual.uid)
          .where('caravana_id', '==', caravanaRaw.toUpperCase())
          .limit(1)
          .get();

        if (!snap.empty) {
          const animal = snap.docs[0].data();
          mostrarHistorialRapido(animal);
        } else {
          contenedorHistorial.innerHTML = `
            <p class="historial-vacio" style="color: #e74c3c;">
              ⚠️ El animal con caravana <strong>${caravanaRaw.toUpperCase()}</strong> no existe en el inventario.
            </p>`;
        }
      } catch (error) {
        console.error('[Sanidad] ❌ Error en consulta rápida de historial:', error);
      }
    };

    inputCaravanaSalud.addEventListener('blur', buscarHistorial);
    inputCaravanaSalud.addEventListener('change', buscarHistorial);
  }

  // ── Botón principal de guardado ──
  document.getElementById('btn-guardar-salud')
    ?.addEventListener('click', guardarRegistroSanitario);

  console.log('[Sanidad] ✅ Módulo sanitario inicializado.');
}


/* ============================================================
   MÓDULO 10: LÓGICA DE NEGOCIO — AGENDA (Tareas de Campo)
   Gestiona la creación, listado y alertas de las tareas.
============================================================ */

/**
 * Variables de estado de la vista Agenda.
 */
let filtroAgendaActivo = 'pendientes'; // 'pendientes' | 'historial'

/**
 * Inicializa la vista de Tareas (Agenda)
 */
function inicializarVistaTarea() {
  const formTarea = document.getElementById('form-tarea');
  if (!formTarea) return;

  // Lógica de botones selectores de Tarea
  const btnTareas = formTarea.querySelectorAll('.btn-selector[data-tarea]');
  const inputFechaParto = document.getElementById('input-fecha-parto');
  const campoFechaParto = document.getElementById('campo-fecha-parto');
  const inputFechaTarea = document.getElementById('input-fecha-tarea');
  let tareaSeleccionada = 'Esquila'; // Valor por defecto

  btnTareas.forEach(btn => {
    btn.addEventListener('click', () => {
      // Remover clase de todos
      btnTareas.forEach(b => {
        b.classList.remove('seleccionado');
        b.setAttribute('aria-pressed', 'false');
      });
      // Activar el clickeado
      btn.classList.add('seleccionado');
      btn.setAttribute('aria-pressed', 'true');
      tareaSeleccionada = btn.dataset.tarea;

      // Mostrar sugerencia si es "Inicio de Servicio"
      if (tareaSeleccionada === 'Inicio de Servicio / Encastre' && inputFechaTarea.value) {
        calcularSugerenciaParto(inputFechaTarea.value);
        campoFechaParto.classList.add('visible');
      } else {
        campoFechaParto.classList.remove('visible');
      }
    });
  });

  // Al cambiar la fecha de la tarea, recalcular parto si corresponde
  inputFechaTarea.addEventListener('change', (e) => {
    if (tareaSeleccionada === 'Inicio de Servicio / Encastre' && e.target.value) {
      calcularSugerenciaParto(e.target.value);
      campoFechaParto.classList.add('visible');
    }
  });

  function calcularSugerenciaParto(fechaBaseStr) {
    if (!fechaBaseStr) return;
    try {
      // Asumiendo fecha local (input type="date" devuelve yyyy-mm-dd)
      const partes = fechaBaseStr.split('-');
      const fechaBase = new Date(partes[0], partes[1] - 1, partes[2]);
      // Sumar 150 días
      fechaBase.setDate(fechaBase.getDate() + 150);
      
      // Formato YYYY-MM-DD
      const anio = fechaBase.getFullYear();
      const mes = String(fechaBase.getMonth() + 1).padStart(2, '0');
      const dia = String(fechaBase.getDate()).padStart(2, '0');
      inputFechaParto.value = `${anio}-${mes}-${dia}`;
    } catch (e) {
      console.error(e);
    }
  }

  // Guardar tarea
  document.getElementById('btn-guardar-tarea')?.addEventListener('click', () => {
    const ambito = document.getElementById('sel-ambito-tarea').value;
    const fecha = inputFechaTarea.value;
    const observaciones = document.getElementById('input-obs-tarea').value;

    if (!tareaSeleccionada || !ambito || !fecha) {
      mostrarToast('⚠️ Faltan campos obligatorios en el formulario.', 'error');
      return;
    }

    guardarTareaManejo(tareaSeleccionada, ambito, fecha, observaciones);

    // Si es servicio, guardar segunda tarea
    if (tareaSeleccionada === 'Inicio de Servicio / Encastre' && inputFechaParto.value) {
      guardarTareaManejo('Alerta: Próxima Parición (Programación Automática)', ambito, inputFechaParto.value, 'Generado automáticamente por sistema tras inicio de servicio.');
    }

    // Limpiar formulario
    document.getElementById('sel-ambito-tarea').value = '';
    inputFechaTarea.value = '';
    document.getElementById('input-obs-tarea').value = '';
    campoFechaParto.classList.remove('visible');
    
    // Refrescar vistas
    listarAgendaLocal();
    actualizarAlertasInicio();
    mostrarToast('✅ Tarea de campo programada exitosamente.', 'exito');
  });

  // Filtros Pendientes/Historial
  const btnPendientes = document.getElementById('btn-tab-pendientes');
  const btnHistorial = document.getElementById('btn-tab-historial');

  if (btnPendientes && btnHistorial) {
    btnPendientes.addEventListener('click', () => {
      filtroAgendaActivo = 'pendientes';
      btnPendientes.classList.add('activo');
      btnHistorial.classList.remove('activo');
      listarAgendaLocal();
    });

    btnHistorial.addEventListener('click', () => {
      filtroAgendaActivo = 'historial';
      btnHistorial.classList.add('activo');
      btnPendientes.classList.remove('activo');
      listarAgendaLocal();
    });
  }
}

/**
 * Guarda la tarea de manejo en LocalStorage.
 */
/**
 * Guarda la tarea de manejo en Firestore.
 */
async function guardarTareaManejo(tarea, ambito, fecha, observaciones) {
  if (!usuarioActual) {
    mostrarToast('Sesión no iniciada.', 'error');
    return;
  }

  try {
    const nuevaTarea = {
      operario_uid:    usuarioActual.uid,
      operario_email:  usuarioActual.email,
      tarea:           sanitizarTexto(tarea),
      ambito:          sanitizarTexto(ambito),
      fechaProgramada: fecha, // Formato YYYY-MM-DD
      observaciones:   sanitizarTexto(observaciones),
      completada:      false,
      fechaCreacion:   new Date().toISOString()
    };

    await db.collection('tareas').add(nuevaTarea);
    console.log('[Agenda] ✅ Tarea guardada en Firestore:', nuevaTarea.tarea);
  } catch (error) {
    console.error('[Agenda] ❌ Error al guardar tarea en Firestore:', error);
    mostrarToast('Error al guardar la tarea en la nube.', 'error');
  }
}

/**
 * Suscribe un listener en tiempo real (onSnapshot) para las tareas de la Agenda
 * en Firestore, filtradas por el operario autenticado.
 */
function suscribirTareasEnTiempoReal() {
  if (desuscribirTareas) {
    desuscribirTareas();
  }

  if (!usuarioActual) return;

  const consulta = db.collection('tareas')
    .where('operario_uid', '==', usuarioActual.uid);

  desuscribirTareas = consulta.onSnapshot(
    (snapshot) => {
      const tareas = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      console.log(`[Agenda] ✅ onSnapshot: ${tareas.length} tareas.`);
      renderizarTareas(tareas);
      actualizarAlertasInicio(tareas);
    },
    (error) => {
      console.error('[Agenda] ❌ Error en onSnapshot de tareas:', error);
    }
  );
}

/**
 * Renderiza la lista de tareas en la UI filtrando según el tab activo.
 */
function renderizarTareas(agenda) {
  const contenedor = document.getElementById('lista-agenda-local');
  if (!contenedor) return;

  try {
    const filtradas = agenda.filter(t => filtroAgendaActivo === 'pendientes' ? !t.completada : t.completada);
    
    // Ordenar por fecha (más cercanas primero para pendientes, más recientes primero para historial)
    filtradas.sort((a, b) => {
      const dateA = new Date(a.fechaProgramada);
      const dateB = new Date(b.fechaProgramada);
      return filtroAgendaActivo === 'pendientes' ? dateA - dateB : dateB - dateA;
    });

    if (filtradas.length === 0) {
      contenedor.innerHTML = `
        <div class="inventario-vacio">
          <span class="vacio-icono">📝</span>
          <p>No hay tareas ${filtroAgendaActivo} para mostrar.</p>
        </div>
      `;
      return;
    }

    const html = filtradas.map(t => {
      const fechaParseada = new Date(t.fechaProgramada + 'T00:00:00'); // Evitar timezone offset issues
      const fechaFormateada = fechaParseada.toLocaleDateString('es-AR', {
        weekday: 'short', day: '2-digit', month: 'short', year: 'numeric'
      });
      
      const btnCompletar = filtroAgendaActivo === 'pendientes' 
        ? `<button type="button" class="btn-marcar-hecho" onclick="completarTareaManejo('${t.id}')">✔️ Marcar Hecho</button>`
        : '';
        
      const icono = t.tarea.includes('Parición') ? '👶' : 
                    t.tarea.includes('Esquila') ? '✂️' : 
                    t.tarea.includes('Vacunación') ? '💉' : '📋';

      return `
        <article class="tarjeta" style="margin-bottom: 12px; display: flex; flex-direction: column; gap: 8px;">
          <div style="display: flex; justify-content: space-between; align-items: flex-start;">
            <div>
              <p class="tarjeta-titulo">${icono} ${t.tarea}</p>
              <p style="font-size: 0.85rem; color: var(--color-texto-suave);"><strong>📅 Fecha:</strong> ${fechaFormateada}</p>
              <p style="font-size: 0.85rem; color: var(--color-texto-suave);"><strong>🎯 Ámbito:</strong> ${t.ambito}</p>
              ${t.observaciones ? `<p style="font-size: 0.8rem; margin-top: 6px;"><i>"${t.observaciones}"</i></p>` : ''}
            </div>
          </div>
          <div style="display: flex; justify-content: flex-end; margin-top: 8px;">
            ${btnCompletar}
          </div>
        </article>
      `;
    }).join('');

    contenedor.innerHTML = html;
  } catch (error) {
    console.error('[Agenda] ❌ Error al renderizar tareas:', error);
  }
}

/**
 * Compatibilidad: listarAgendaLocal activa la suscripción en tiempo real.
 */
function listarAgendaLocal() {
  if (!desuscribirTareas && usuarioActual) {
    suscribirTareasEnTiempoReal();
  }
}

/**
 * Marca una tarea como completada en Firestore.
 */
window.completarTareaManejo = async function(idTarea) {
  try {
    await db.collection('tareas').doc(idTarea).update({
      completada: true,
      fechaModificacion: new Date().toISOString()
    });
    mostrarToast('✅ Tarea marcada como completada.', 'exito');
  } catch (error) {
    console.error('[Agenda] ❌ Error al completar tarea en Firestore:', error);
    mostrarToast('Error al completar la tarea en la nube.', 'error');
  }
};

/**
 * Actualiza el panel de inicio con las tareas pendientes urgentes.
 */
window.actualizarAlertasInicio = function(agendaRecibida) {
  const contenedor = document.getElementById('contenedor-alertas-urgentes');
  if (!contenedor) return;

  try {
    // Si no recibimos agenda, la inicializamos vacía
    const agenda = Array.isArray(agendaRecibida) ? agendaRecibida : [];
    const pendientes = agenda.filter(t => !t.completada);
    
    if (pendientes.length === 0) {
      contenedor.innerHTML = '';
      return;
    }

    const hoy = new Date();
    hoy.setHours(0,0,0,0);
    const dentroDe7Dias = new Date(hoy);
    dentroDe7Dias.setDate(hoy.getDate() + 7);

    const alertasHtml = pendientes.map(t => {
      const fechaTarea = new Date(t.fechaProgramada + 'T00:00:00');
      let clase = '';
      let textoEstado = '';
      
      if (fechaTarea < hoy) {
        clase = 'vencida';
        textoEstado = '⚠️ Vencida';
      } else if (fechaTarea.getTime() === hoy.getTime()) {
        clase = 'urgente-hoy';
        textoEstado = '🟢 Hoy';
      } else if (fechaTarea > hoy && fechaTarea <= dentroDe7Dias) {
        clase = 'proxima';
        textoEstado = '🟡 Próximamente';
      } else {
        return null; // No mostrar si falta más de 7 días
      }

      const fechaFormateada = fechaTarea.toLocaleDateString('es-AR', {
        day: '2-digit', month: 'short'
      });

      return `
        <div class="alerta-urgente ${clase}">
          <div class="alerta-detalle">
            <p class="alerta-titulo">${t.tarea}</p>
            <p class="alerta-fecha">${textoEstado} - <strong>${fechaFormateada}</strong></p>
          </div>
          <button type="button" class="btn-marcar-hecho" onclick="completarTareaManejo('${t.id}')">✔️</button>
        </div>
      `;
    }).filter(html => html !== null).join('');

    contenedor.innerHTML = alertasHtml;

  } catch (error) {
    console.error('[Agenda] ❌ Error al actualizar alertas:', error);
  }
};


/* ============================================================
   MÓDULO 11: REGISTRO DEL SERVICE WORKER (PWA)
   Registra el SW para habilitar el modo Offline-First.
============================================================ */




/* ============================================================
   MÓDULO 10: INICIALIZACIÓN DE LA APLICACIÓN
   Punto de entrada principal. Orquesta el arranque de todos
   los módulos en el orden correcto.
============================================================ */

let appInicializada = false;

/**
 * Inicializa la estructura base y los listeners de la aplicación una única vez.
 * Esto evita duplicar los event listeners del DOM tras múltiples inicios de sesión.
 */
function inicializarAppUnaVez() {
  if (appInicializada) return;
  console.log('🐑 OvIAgro — Inicializando estructura base y listeners del DOM...');

  // 1. Arrancar el enrutador SPA (muestra la vista inicial)
  inicializarRouter();

  // 2. Conectar los eventos de la vista Inicio
  inicializarVistaInicio();

  // 3. Conectar los eventos del formulario de Alta de Animal
  inicializarFormularioAlta();

  // 4. Inicializar el módulo de Salud (sanitario)
  inicializarModuloSalud();

  // 5. Inicializar el módulo de Tareas de Campo
  inicializarVistaTarea();

  appInicializada = true;
  console.log('✅ Estructura base inicializada correctamente.');
}

/**
 * Punto de entrada inicial al cargar el documento.
 * Espera a que Auth determine el estado.
 */
function arrancarAplicacion() {
  console.log('🐑 OvIAgro — Estructura del DOM lista. Esperando autenticación...');
}

// --- Punto de entrada: esperar a que el DOM esté listo ---
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', arrancarAplicacion);
} else {
  arrancarAplicacion();
}

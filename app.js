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
   VARIABLE GLOBAL: PROMPT DIFERIDO DE INSTALACIÓN PWA
   Se declara AQUÍ, en el ámbito global y fuera de cualquier función,
   para que tanto el evento 'beforeinstallprompt' como el listener
   del botón puedan acceder y modificarla sin conflictos.
============================================================ */

/** @type {Event|null} Guarda el evento de instalación para dispararlo luego */
let deferredPrompt = null;

// Variable global para mantener el inventario en memoria caché local y actualizar los contadores
let animalesCache = [];

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
  // Evita que el navegador muestre su propio cartel de instalación automáticamente
  e.preventDefault();
  // Guardamos el evento para poder dispararlo más tarde con nuestro botón propio
  deferredPrompt = e;
  console.log('[PWA] 📲 Evento beforeinstallprompt capturado. La app es instalable.');

  // Mostrar nuestro botón personalizado de instalación
  const btn = document.getElementById('btnInstalar');
  if (btn) btn.style.display = 'block';
});

window.addEventListener('appinstalled', (e) => {
  console.log('[PWA] 🐑 Aplicación instalada con éxito.');
  // Limpiar el deferredPrompt ya que fue consumido
  deferredPrompt = null;
  // Ocultar el botón si siguiera visible
  const btn = document.getElementById('btnInstalar');
  if (btn) btn.style.display = 'none';
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
    if (predioLocal && (predioLocal.objetivo || predioLocal.coordenadas || predioLocal.productor || predioLocal.establecimiento)) {
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
        const inputProd = document.getElementById('input-productor');
        const inputEst = document.getElementById('input-establecimiento');

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
        if (predio.productor && inputProd) {
          inputProd.value = predio.productor;
        }
        if (predio.establecimiento && inputEst) {
          inputEst.value = predio.establecimiento;
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
  // --- Conectar botón de Login con Google ---
  const btnLogin = document.getElementById('btn-google-login');
  if (btnLogin) {
    btnLogin.addEventListener('click', iniciarSesionConGoogle);
  }

  // --- Lógica del Botón de Instalación PWA (id="btnInstalar") ---
  // Este botón solo es visible si el navegador disparó 'beforeinstallprompt'.
  // Al presionarlo, mostramos el prompt nativo de instalación del navegador.
  const btnInstalar = document.getElementById('btnInstalar');
  if (btnInstalar) {
    btnInstalar.addEventListener('click', async () => {
      // Verificar que el prompt diferido esté disponible
      if (!deferredPrompt) {
        console.warn('[PWA] No hay prompt de instalación disponible.');
        return;
      }

      // Lanzar el diálogo nativo de instalación del sistema operativo
      deferredPrompt.prompt();

      // Esperar la decisión del operario (acepta o rechaza instalar)
      const { outcome } = await deferredPrompt.userChoice;
      console.log(`[PWA] Decisión del operario: ${outcome}`);

      // Independientemente de la respuesta, ocultar el botón y
      // resetear la variable. El prompt solo puede usarse una vez.
      btnInstalar.style.display = 'none';
      deferredPrompt = null;

      if (outcome === 'accepted') {
        mostrarToast('¡Instalando OvIAgro... Chequeá tu pantalla de inicio 🐑', 'exito', 5000);
      } else {
        console.log('[PWA] El operario decidió no instalar por ahora.');
      }
    });
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
  const productor = document.getElementById('input-productor')?.value || '';
  const establecimiento = document.getElementById('input-establecimiento')?.value || '';
  const objetivo = document.getElementById('sel-objetivo')?.value || '';

  if (!productor || !establecimiento || !objetivo) {
    mostrarToast('⚠️ Completá todos los campos obligatorios antes de guardar.', 'error');
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
      productor: sanitizarTexto(productor),
      establecimiento: sanitizarTexto(establecimiento),
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

  let { caravana, nombre, sexo, raza, categoria, fecha_nac, peso_nac, madre, padre, castrado, foto, peso_destete } = nuevoAnimal;

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
    mostrarToast('⚠️ Seleccioná o escribí una raza.', 'error');
    document.getElementById('input-raza')?.focus();
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
    peso_destete = peso_destete ? parseFloat(peso_destete)            : null;
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
      peso_destete:     peso_destete,
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
    const docRef = await db.collection('animales').add(animalSanitizado);

    console.log(`[Inventario] ✅ Animal guardado en Firestore: ${animalSanitizado.caravana_id}`);
    mostrarToast(`✅ Caravana ${animalSanitizado.caravana_id} registrada con éxito.`, 'exito');

    // Actualizar la caché local para refresco instantáneo y recalcular contadores
    const nuevoAnimalCacheado = { id: docRef.id, ...animalSanitizado };
    if (!animalesCache.some(a => a.caravana_id === nuevoAnimalCacheado.caravana_id)) {
      animalesCache.push(nuevoAnimalCacheado);
      actualizarContadores();
    }

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
  // Repoblar selectores de caravana en Salud y Tareas con los animales actuales
  cargarSelectoresAnimales();
}

/**
 * Renderiza las tarjetas del inventario en el DOM.
 * Es llamada automáticamente por el listener onSnapshot.
 * @param {Array} inventario - Array de objetos animal desde Firestore.
 */
/**
 * Renderiza las tarjetas del inventario con botones de Ojo (ver) y Basura (eliminar).
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

  // Icono SVG de ojo (ver detalles)
  const icoOjo = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
  // Icono SVG de lápiz (editar)
  const icoLapiz = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>`;
  // Icono SVG de cesto de basura (eliminar)
  const icoBasura = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>`;

  const htmlTarjetas = inventario.map((animal) => {
    const iconoSexo    = animal.sexo === 'Macho' ? '♂️' : '♀️';
    const textoCast   = animal.castrado ? ' (Castrado)' : '';
    const textoDest   = animal.peso_destete ? `<br><strong>Peso Destete:</strong> ${animal.peso_destete} Kg` : '';

    let badgeRetiro = '';
    if (animal.fecha_limite_carencia) {
      const ahora = new Date();
      const fRet  = new Date(animal.fecha_limite_carencia);
      if (ahora < fRet) {
        const fFmt = fRet.toLocaleDateString('es-AR', { day:'2-digit', month:'2-digit', year:'numeric' });
        badgeRetiro = `<div class="badge-retiro" role="alert">⚠️ RETIRO ACTIVO — No vender hasta ${fFmt}</div>`;
      }
    }

    // Escapamos el ID del documento de Firestore para usarlo como atributo data-
    const docId = animal.id || '';

    const fotoMiniatura = animal.foto
      ? `<div class="mini-foto-animal" aria-label="Foto de ${animal.caravana_id}"><img src="${animal.foto}" alt="Miniatura"></div>`
      : `<div class="mini-foto-animal vacio" aria-label="Sin foto"><span>🐑</span></div>`;

    return `
      <article class="animal-tarjeta" role="listitem" aria-label="Animal caravana ${animal.caravana_id}">
        <div class="animal-tarjeta-cuerpo">
          ${fotoMiniatura}
          <div class="animal-tarjeta-datos">
            <p class="animal-caravana">${animal.caravana_id}</p>
            <div class="animal-detalles">
              ${animal.nombre ? `<strong>Nombre:</strong> ${animal.nombre}<br>` : ''}
              <strong>Sexo:</strong> ${iconoSexo} ${animal.sexo}${textoCast}<br>
              <strong>Raza:</strong> ${animal.raza}<br>
              <strong>Categoría:</strong> ${animal.categoria}${textoDest}
            </div>
          </div>
        </div>
        ${badgeRetiro}
        <p class="animal-fecha">Alta: ${formatearFecha(animal.fechaAlta)}</p>
        <!-- Botones de acción: Ver (ojo), Editar (lápiz) y Eliminar (basura) -->
        <div class="animal-acciones">
          <button
            type="button"
            class="btn-accion btn-ver-animal"
            data-id="${docId}"
            aria-label="Ver detalles de ${animal.caravana_id}"
            onclick="abrirModalAnimal('${docId}')"
          >${icoOjo} Ver</button>
          <button
            type="button"
            class="btn-accion btn-editar-animal"
            data-id="${docId}"
            aria-label="Editar ${animal.caravana_id}"
            onclick="editarAnimal('${docId}')"
          >${icoLapiz} Editar</button>
          <button
            type="button"
            class="btn-accion btn-eliminar-animal"
            data-id="${docId}"
            aria-label="Eliminar ${animal.caravana_id}"
            onclick="eliminarAnimal('${docId}', '${animal.caravana_id}')"
          >${icoBasura} Eliminar</button>
        </div>
      </article>`;
  }).join('');

  contenedor.innerHTML = htmlTarjetas;
}

/* ============================================================
   MÓDULO: ELIMINACIÓN DE ANIMAL CON CONFIRMACIÓN
   Pide confirmación nativa antes de borrar de Firestore.
============================================================ */

/**
 * Elimina un documento de animal de Firestore tras confirmación del operario.
 * @param {string} docId     - ID del documento en Firestore.
 * @param {string} caravana  - Número de caravana legible (para el mensaje).
 */
window.eliminarAnimal = async function(docId, caravana) {
  if (!docId || !usuarioActual) return;

  // Confirmación nativa del navegador — sencilla y efectiva en campo
  const confirmado = confirm(
    `¿Estás seguro de que deseas eliminar este animal permanentemente?\n\nCaravana: ${caravana}\n\nEsta acción NO se puede deshacer.`
  );
  if (!confirmado) return;

  try {
    // Eliminar el documento de la colección 'animales' en Firestore
    await db.collection('animales').doc(docId).delete();
    mostrarToast(`✅ Animal ${caravana} eliminado correctamente.`, 'exito', 4000);
    console.log(`[Inventario] ✅ Animal eliminado: ${caravana} (ID: ${docId})`);
    // onSnapshot detectará el cambio y re-renderizará la lista automáticamente
  } catch (error) {
    console.error('[Inventario] ❌ Error al eliminar animal en Firestore:', error);
    mostrarToast('Error al eliminar. Verificá tu conexión.', 'error');
  }
};

/* ============================================================
   MÓDULO: MODAL DE DETALLE COMPLETO DEL ANIMAL
   Abre un panel flotante con toda la información del animal
   y sus historiales cruzados consultados en Firestore.
============================================================ */

/**
 * Calcula la edad exacta de un animal a partir de su fecha de nacimiento.
 * Compara con la fecha actual del sistema.
 * @param {string} fechaNacStr - Fecha de nacimiento en formato 'YYYY-MM-DD' o ISO.
 * @returns {string} Texto legible como "4 meses", "2 años y 1 mes", "Sin fecha".
 */
function calcularEdadAnimal(fechaNacStr) {
  if (!fechaNacStr) return 'Sin fecha de nacimiento';

  try {
    // Construir fecha local evitando el offset de timezone (input type=date da 'YYYY-MM-DD')
    const partes = fechaNacStr.substring(0, 10).split('-');
    const nacimiento = new Date(Number(partes[0]), Number(partes[1]) - 1, Number(partes[2]));
    const hoy = new Date();

    // Diferencia en meses totales
    let anios = hoy.getFullYear() - nacimiento.getFullYear();
    let meses  = hoy.getMonth()    - nacimiento.getMonth();

    // Ajustar si el día actual es menor al día de nacimiento
    if (hoy.getDate() < nacimiento.getDate()) meses--;

    // Ajustar años si los meses son negativos
    if (meses < 0) { anios--; meses += 12; }

    // Formatear resultado legible en español
    if (anios === 0 && meses === 0)  return 'Menos de 1 mes';
    if (anios === 0)                 return `${meses} mes${meses !== 1 ? 'es' : ''}`;
    if (meses === 0)                 return `${anios} año${anios !== 1 ? 's' : ''}`;
    return `${anios} año${anios !== 1 ? 's' : ''} y ${meses} mes${meses !== 1 ? 'es' : ''}`;
  } catch (e) {
    console.warn('[Modal] Error al calcular edad:', e);
    return 'Error de cálculo';
  }
}

/**
 * Genera el HTML de un dato individual para la grilla del modal.
 * @param {string} etiqueta   - Nombre del campo.
 * @param {string} valor      - Valor a mostrar.
 * @param {boolean} ancho     - Si true, ocupa todo el ancho de la grilla.
 * @param {string} claseValor - Clase CSS adicional para el valor.
 * @returns {string} HTML del elemento .modal-dato.
 */
function construirDatoModal(etiqueta, valor, ancho = false, claseValor = '') {
  const claseAncho = ancho ? ' ancho-completo' : '';
  return `
    <div class="modal-dato${claseAncho}">
      <p class="modal-dato-etiqueta">${etiqueta}</p>
      <p class="modal-dato-valor ${claseValor}">${valor || '<em style="color:#aaa">No registrado</em>'}</p>
    </div>`;
}

/**
 * Abre el modal de detalle con los datos del animal identificado por docId.
 * Realiza tres consultas cruzadas en Firestore para llenar los historiales:
 *   1. historial_sanitario (campo array dentro del doc del animal)
 *   2. Colección 'observaciones' vinculada por caravana_id
 *   3. Colección 'tareas' vinculada por ambito (caravana)
 * @param {string} docId - ID del documento del animal en Firestore.
 */
window.abrirModalAnimal = async function(docId) {
  if (!docId || !usuarioActual) return;

  const overlay = document.getElementById('modal-animal-overlay');
  if (!overlay) return;

  // Abrir el overlay y bloquear el scroll del body
  overlay.classList.add('abierto');
  document.body.style.overflow = 'hidden';

  // Guardar el docId actual para que el botón PDF del modal sepa qué animal exportar
  modalAnimalDocIdActual = docId;
  const btnPdfModal = document.getElementById('btn-exportar-ficha-pdf');
  if (btnPdfModal) {
    // Asignar el handler directamente con el ID capturado en este closure
    btnPdfModal.onclick = () => exportarFichaIndividual(docId);
  }

  // Mostrar spinners de carga en todos los paneles mientras se consulta Firestore
  ['cargando-observaciones', 'cargando-sanidad', 'cargando-tareas'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'block';
  });
  ['lista-observaciones', 'lista-sanidad-modal', 'lista-tareas-modal'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = '';
  });

  try {
    // ── Obtener el documento del animal desde Firestore ──
    const docSnap = await db.collection('animales').doc(docId).get();
    if (!docSnap.exists) {
      mostrarToast('Animal no encontrado en la base de datos.', 'error');
      cerrarModalAnimal();
      return;
    }

    const a = docSnap.data(); // Objeto con todos los campos del animal
    const caravana = a.caravana_id || '—';

    // Foto ampliada en cabecera del modal
    const elFotoCont = document.getElementById('modal-foto-contenedor');
    const elFotoImg  = document.getElementById('modal-foto-img');
    if (elFotoCont && elFotoImg) {
      if (a.foto) {
        elFotoImg.src = a.foto;
        elFotoCont.style.display = 'block';
      } else {
        elFotoImg.src = '';
        elFotoCont.style.display = 'none';
      }
    }

    // ── Llenar CABECERA del modal ──
    const elCaravana = document.getElementById('modal-caravana-titulo');
    const elNombre   = document.getElementById('modal-nombre-titulo');
    if (elCaravana) elCaravana.textContent = caravana;
    if (elNombre)   elNombre.textContent   = a.nombre || '';

    // ── SECCIÓN 1: Datos base ──
    const sexoTexto    = a.sexo || '—';
    const castBadge    = a.castrado
      ? '<span class="badge-castrado-si">Sí</span>'
      : '<span class="badge-castrado-no">No</span>';

    const sBase = document.getElementById('modal-datos-base');
    if (sBase) {
      sBase.innerHTML =
        construirDatoModal('Raza', a.raza) +
        construirDatoModal('Categoría', a.categoria, true) +
        construirDatoModal('Sexo', sexoTexto) +
        construirDatoModal('Castrado/a', castBadge);
    }

    // ── SECCIÓN 2: Nacimiento y edad calculada dinámicamente ──
    const fechaNac = a.fecha_nacimiento || null;
    const edadCalc = calcularEdadAnimal(fechaNac);
    const fechaNacFmt = fechaNac
      ? new Date(fechaNac + 'T00:00:00').toLocaleDateString('es-AR', { day:'2-digit', month:'2-digit', year:'numeric' })
      : null;

    const sNac = document.getElementById('modal-datos-nacimiento');
    if (sNac) {
      sNac.innerHTML =
        construirDatoModal('Fecha de Nacimiento', fechaNacFmt) +
        construirDatoModal('Edad Actual', edadCalc, false, 'edad-calculada') +
        construirDatoModal('Peso al Nacer (Kg)', a.peso_nacimiento ? `${a.peso_nacimiento} Kg` : null) +
        construirDatoModal('Peso al Destete (Kg)', a.peso_destete ? `${a.peso_destete} Kg` : null);
    }

    // ── SECCIÓN 3: Filiación genealógica ──
    const sFil = document.getElementById('modal-datos-filiacion');
    if (sFil) {
      sFil.innerHTML =
        construirDatoModal('Caravana del Padre', a.caravana_padre) +
        construirDatoModal('Caravana de la Madre', a.caravana_madre);
    }

    // ── SECCIÓN 4: Cargar los tres historiales en paralelo ──
    await cargarHistorialesModal(a, caravana);

  } catch (error) {
    console.error('[Modal] ❌ Error al abrir modal del animal:', error);
    mostrarToast('Error al cargar los datos del animal.', 'error');
    cerrarModalAnimal();
  }
};

/**
 * Carga y renderiza los tres historiales cruzados en el modal:
 *   - Observaciones (colección 'observaciones' o campo en el doc)
 *   - Sanidad       (array historial_sanitario dentro del doc del animal)
 *   - Tareas        (colección 'tareas' filtrada por caravana en campo 'ambito')
 * @param {Object} animal   - Datos del documento del animal.
 * @param {string} caravana - Número de caravana para filtrar otras colecciones.
 */
async function cargarHistorialesModal(animal, caravana) {

  // ── HISTORIAL 1: OBSERVACIONES ──
  // Primero busca campo 'observaciones' array dentro del doc, luego colección propia.
  try {
    const elCarg = document.getElementById('cargando-observaciones');
    const elList = document.getElementById('lista-observaciones');

    // Intentar colección independiente 'observaciones' filtrada por caravana
    const snapObs = await db.collection('observaciones')
      .where('operario_uid', '==', usuarioActual.uid)
      .where('caravana_id',  '==', caravana)
      .get();

    // Recolectar también observaciones que puedan estar en campo array del doc
    let items = [];
    if (!snapObs.empty) {
      items = snapObs.docs
        .map(d => d.data())
        .sort((a, b) => new Date(b.fecha || 0) - new Date(a.fecha || 0));
    }

    if (elCarg) elCarg.style.display = 'none';
    if (elList) {
      elList.innerHTML = items.length === 0
        ? '<p class="modal-historial-vacio">Sin observaciones registradas para este animal.</p>'
        : items.map(obs => `
            <div class="modal-historial-item">
              <strong>${obs.titulo || 'Nota'}</strong>
              ${obs.descripcion ? `<br>${obs.descripcion}` : ''}
              <p class="item-fecha">📅 ${formatearFecha(obs.fecha)}</p>
            </div>`).join('');
    }
  } catch (e) {
    console.warn('[Modal] No se pudo cargar colección observaciones:', e.message);
    const el = document.getElementById('lista-observaciones');
    if (el) el.innerHTML = '<p class="modal-historial-vacio">No hay observaciones disponibles.</p>';
    const elC = document.getElementById('cargando-observaciones');
    if (elC) elC.style.display = 'none';
  }

  // ── HISTORIAL 2: SANIDAD ──
  // Los registros sanitarios se guardan como array 'historial_sanitario' dentro del doc del animal.
  try {
    const elCarg = document.getElementById('cargando-sanidad');
    const elList = document.getElementById('lista-sanidad-modal');

    const histSan = Array.isArray(animal.historial_sanitario) ? animal.historial_sanitario : [];
    // Ordenar cronológicamente del más reciente al más antiguo
    const sanOrdenado = [...histSan].sort((a, b) => new Date(b.fecha || 0) - new Date(a.fecha || 0));

    if (elCarg) elCarg.style.display = 'none';
    if (elList) {
      elList.innerHTML = sanOrdenado.length === 0
        ? '<p class="modal-historial-vacio">Sin registros sanitarios para este animal.</p>'
        : sanOrdenado.map(reg => {
            const via  = reg.via_administracion ? ` | Vía: ${reg.via_administracion}` : '';
            const fam  = reg.famacha            ? ` | Famacha: ${reg.famacha}` : '';
            const obs  = reg.observaciones      ? `<br>📝 ${reg.observaciones}` : '';
            const ret  = reg.fecha_limite_carencia
              ? `<br>⚠️ Retiro hasta: <strong>${formatearFecha(reg.fecha_limite_carencia)}</strong>`
              : '';
            return `
              <div class="modal-historial-item sanidad">
                <strong>${reg.tipo_evento}</strong> — ${reg.producto} (${reg.dosis})${via}${fam}
                ${obs}${ret}
                <p class="item-fecha">📅 ${formatearFecha(reg.fecha)}</p>
              </div>`;
          }).join('');
    }
  } catch (e) {
    console.error('[Modal] Error al renderizar historial sanitario:', e);
    const el = document.getElementById('lista-sanidad-modal');
    if (el) el.innerHTML = '<p class="modal-historial-vacio">Error al cargar registros sanitarios.</p>';
    const elC = document.getElementById('cargando-sanidad');
    if (elC) elC.style.display = 'none';
  }

  // ── HISTORIAL 3: TAREAS DE MANEJO ──
  // Busca en colección 'tareas' aquellas cuyo campo 'ambito' contiene la caravana del animal.
  try {
    const elCarg = document.getElementById('cargando-tareas');
    const elList = document.getElementById('lista-tareas-modal');

    const snapTar = await db.collection('tareas')
      .where('operario_uid', '==', usuarioActual.uid)
      .where('ambito', '==', caravana)
      .get();

    // Si no hay tareas específicas por caravana, también buscar por nombre
    let tareas = snapTar.docs.map(d => ({ id: d.id, ...d.data() }));
    tareas.sort((a, b) => new Date(b.fechaProgramada || 0) - new Date(a.fechaProgramada || 0));

    if (elCarg) elCarg.style.display = 'none';
    if (elList) {
      elList.innerHTML = tareas.length === 0
        ? '<p class="modal-historial-vacio">Sin tareas de manejo vinculadas a este animal.</p>'
        : tareas.map(t => {
            const fechaFmt = t.fechaProgramada
              ? new Date(t.fechaProgramada + 'T00:00:00').toLocaleDateString('es-AR', { day:'2-digit', month:'2-digit', year:'numeric' })
              : '—';
            const estado = t.completada
              ? '<span style="color:#27ae60; font-weight:bold;">✔ Completada</span>'
              : '<span style="color:#e67e22; font-weight:bold;">⏳ Pendiente</span>';
            return `
              <div class="modal-historial-item tarea">
                <strong>${t.tarea}</strong> ${estado}
                ${t.observaciones ? `<br>📝 ${t.observaciones}` : ''}
                <p class="item-fecha">📅 Programada: ${fechaFmt}</p>
              </div>`;
          }).join('');
    }
  } catch (e) {
    console.warn('[Modal] No se pudo cargar tareas para esta caravana:', e.message);
    const el = document.getElementById('lista-tareas-modal');
    if (el) el.innerHTML = '<p class="modal-historial-vacio">No hay tareas disponibles.</p>';
    const elC = document.getElementById('cargando-tareas');
    if (elC) elC.style.display = 'none';
  }
}

/**
 * Cierra el modal de detalle del animal y restaura el scroll del body.
 */
function cerrarModalAnimal() {
  const overlay = document.getElementById('modal-animal-overlay');
  if (overlay) overlay.classList.remove('abierto');
  document.body.style.overflow = '';
}

/**
 * Inicializa los eventos del modal:
 *   - Botón X de cierre
 *   - Clic fuera del panel (en el overlay) para cerrar
 *   - Pestañas de historiales (Observaciones / Sanidad / Tareas)
 */
function inicializarModal() {
  // ── Botón de cerrar (X) ──
  const btnCerrar = document.getElementById('modal-btn-cerrar');
  if (btnCerrar) {
    btnCerrar.addEventListener('click', cerrarModalAnimal);
  }

  // ── Cerrar al hacer clic en el fondo oscuro (overlay) ──
  const overlay = document.getElementById('modal-animal-overlay');
  if (overlay) {
    overlay.addEventListener('click', (e) => {
      // Solo cerrar si se hizo clic directamente en el overlay, no en el panel
      if (e.target === overlay) cerrarModalAnimal();
    });
  }

  // ── Cerrar con la tecla Escape ──
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') cerrarModalAnimal();
  });

  // ── Pestañas de historiales cruzados ──
  const tabs = document.querySelectorAll('.modal-tab');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      // Desactivar todas las pestañas y paneles
      tabs.forEach(t => {
        t.classList.remove('activo');
        t.setAttribute('aria-selected', 'false');
      });
      document.querySelectorAll('.modal-historial-panel').forEach(p => {
        p.classList.remove('activo');
      });

      // Activar la pestaña clickeada y su panel correspondiente
      tab.classList.add('activo');
      tab.setAttribute('aria-selected', 'true');
      const panelId = tab.dataset.panel;
      const panel   = document.getElementById(panelId);
      if (panel) panel.classList.add('activo');
    });
  });

  console.log('[Modal] ✅ Modal de detalle de animal inicializado.');
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
            animalesCache = [];
            renderizarInventario([]);
            actualizarContadores();
            return;
          }
          
          // Llenar animalesCache con datos reales
          animalesCache = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

          // Mapear documentos y ordenar por fechaAlta descendente en el cliente
          const inventario = [...animalesCache].sort((a, b) => {
              const fa = a.fechaAlta ? new Date(a.fechaAlta) : new Date(0);
              const fb = b.fechaAlta ? new Date(b.fechaAlta) : new Date(0);
              return fb - fa;
            });
          renderizarInventario(inventario);
          actualizarContadores();
          // → Repoblar los selectores de Salud y Tareas cuando el inventario cambia
          actualizarSelectoresAnimales(animalesCache);
          console.log(`[Inventario] ✅ onSnapshot: ${inventario.length} animales.`);
        } catch (innerErr) {
          console.error('[Inventario] ❌ Error procesando snapshot de animales:', innerErr);
        }
      },
      (error) => {
        // Error real (permisos, red) — solo en consola, nunca interrumpe al usuario
        console.error('[Inventario] ❌ Error Firestore en animales:', error);
        animalesCache = [];
        renderizarInventario([]);
        actualizarContadores();
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

    let castradoSeleccionado = false;
    const radiosCastrado = document.getElementsByName('castrado');
    for (const r of radiosCastrado) {
      if (r.checked) {
        castradoSeleccionado = (r.value === 'si');
        break;
      }
    }

    const datosFormulario = {
      caravana:      document.getElementById('input-caravana')?.value   || '',
      nombre:        document.getElementById('input-nombre')?.value     || '',
      sexo:          sexoSeleccionado,
      raza:          document.getElementById('input-raza')?.value       || '',
      categoria:     document.getElementById('sel-categoria')?.value    || '',
      fecha_nac:     document.getElementById('input-fecha-nac')?.value  || '',
      peso_nac:      document.getElementById('input-peso-nac')?.value   || '',
      peso_destete:  document.getElementById('input-peso-destete')?.value || '',
      madre:         document.getElementById('input-madre')?.value      || '',
      padre:         document.getElementById('input-padre')?.value      || '',
      castrado:      castradoSeleccionado,
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
  const camposInput = ['input-caravana', 'input-nombre', 'input-fecha-nac', 'input-peso-nac', 'input-peso-destete', 'input-madre', 'input-padre', 'input-raza'];
  camposInput.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });

  const camposSelect = ['sel-categoria'];
  camposSelect.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });

  const radiosSexo = document.getElementsByName('sexo');
  radiosSexo.forEach(r => r.checked = false);

  const radioCastradoNo = document.getElementById('castrado-no');
  if (radioCastradoNo) radioCastradoNo.checked = true;
  const radioCastradoSi = document.getElementById('castrado-si');
  if (radioCastradoSi) radioCastradoSi.checked = false;

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

  document.getElementById('btn-cerrar-sesion')
    ?.addEventListener('click', cerrarSesion);

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
      // ── MODO INDIVIDUAL: leer del select dinámico ──
      const caravanaRaw = (document.getElementById('select-caravana-salud')?.value || '').trim();

      if (!caravanaRaw) {
        mostrarToast('⚠️ Seleccioná el animal de la lista.', 'error');
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
  // Limpiar inputs de texto y numéricos (ya no existe input-caravana-salud; usar el select)
  ['input-producto-salud', 'input-dosis-salud',
   'input-carencia-salud', 'input-obs-salud'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });

  // Resetear el selector dinámico de animales (modo individual)
  const selCaravana = document.getElementById('select-caravana-salud');
  if (selCaravana) selCaravana.value = '';

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

  // ── Consulta rápida de historial al SELECCIONAR un animal del desplegable ──
  // Cuando el operario elige un animal del <select>, se carga su historial sanitario
  // debajo del formulario para consulta rápida sin abrir el modal.
  const selectCaravanaSalud = document.getElementById('select-caravana-salud');

  const buscarHistorial = async (caravanaRaw) => {
    const contenedorHistorial = document.getElementById('historial-sanitarios-rapido');
    if (!contenedorHistorial || !caravanaRaw?.trim()) {
      if (contenedorHistorial) contenedorHistorial.innerHTML = '';
      return;
    }
    if (!usuarioActual) return;
    try {
      const snap = await db.collection('animales')
        .where('operario_uid', '==', usuarioActual.uid)
        .where('caravana_id', '==', caravanaRaw.trim().toUpperCase())
        .limit(1)
        .get();
      if (!snap.empty) {
        mostrarHistorialRapido(snap.docs[0].data());
      } else {
        contenedorHistorial.innerHTML = `
          <p class="historial-vacio" style="color:#e74c3c;">
            ⚠️ El animal con caravana <strong>${caravanaRaw.toUpperCase()}</strong> no existe en el inventario.
          </p>`;
      }
    } catch (error) {
      console.error('[Sanidad] ❌ Error en consulta rápida de historial:', error);
    }
  };

  if (selectCaravanaSalud) {
    selectCaravanaSalud.addEventListener('change', () => buscarHistorial(selectCaravanaSalud.value));
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
    let ambito = document.getElementById('sel-ambito-tarea').value;
    const fecha = inputFechaTarea.value;
    const observaciones = document.getElementById('input-obs-tarea').value;

    // Si hay un animal individual seleccionado, el ámbito es esa caravana específica
    // Esto permite vincular la tarea a la caravana para verla en el modal del animal.
    const selAnimalTarea = document.getElementById('select-caravana-tareas');
    const animalEspecifico = selAnimalTarea?.value?.trim() || '';
    if (animalEspecifico) {
      ambito = animalEspecifico; // Trazabilidad directa en el historial del modal
    }

    if (!tareaSeleccionada || !ambito || !fecha) {
      mostrarToast('⚠️ Faltan campos obligatorios en el formulario.', 'error');
      return;
    }

    guardarTareaManejo(tareaSeleccionada, ambito, fecha, observaciones);

    // Si es servicio, guardar segunda tarea automática de parición
    if (tareaSeleccionada === 'Inicio de Servicio / Encastre' && inputFechaParto.value) {
      guardarTareaManejo('Alerta: Próxima Parición (Programación Automática)', ambito, inputFechaParto.value, 'Generado automáticamente por sistema tras inicio de servicio.');
    }

    // Limpiar formulario
    document.getElementById('sel-ambito-tarea').value = '';
    if (selAnimalTarea) selAnimalTarea.value = '';
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
  const contenedorHoy = document.getElementById('contenedor-tareas-hoy');
  const contenedorOtras = document.getElementById('contenedor-otras-tareas');
  if (!contenedorHoy || !contenedorOtras) return;

  try {
    const agenda = Array.isArray(agendaRecibida) ? agendaRecibida : [];
    const pendientes = agenda.filter(t => !t.completada);
    
    // Resetear contenidos
    contenedorHoy.innerHTML = '';
    contenedorOtras.innerHTML = '';

    const hoy = new Date();
    hoy.setHours(0,0,0,0);

    const tareasHoy = [];
    const tareasOtras = [];

    pendientes.forEach(t => {
      const fechaTarea = new Date(t.fechaProgramada + 'T00:00:00');
      fechaTarea.setHours(0,0,0,0);
      
      if (fechaTarea.getTime() === hoy.getTime()) {
        tareasHoy.push(t);
      } else {
        tareasOtras.push(t);
      }
    });

    // Render Tareas de Hoy
    if (tareasHoy.length === 0) {
      contenedorHoy.innerHTML = `
        <div style="font-size: 0.9rem; color: #555; font-style: italic;">
          Sin tareas programadas para hoy.
        </div>`;
    } else {
      contenedorHoy.innerHTML = tareasHoy.map(t => {
        return `
          <div class="tarea-item-inicio">
            <div class="tarea-info-inicio">
              <span class="tarea-nombre-inicio">📌 ${t.tarea}</span>
              <div class="tarea-fecha-inicio">Ámbito: ${t.ambito}</div>
            </div>
            <button type="button" class="btn-marcar-hecho" onclick="completarTareaManejo('${t.id}')">✔️</button>
          </div>`;
      }).join('');
    }

    // Render Otras Tareas
    if (tareasOtras.length === 0) {
      contenedorOtras.innerHTML = `
        <div style="font-size: 0.9rem; color: #555; font-style: italic;">
          Sin próximas tareas.
        </div>`;
    } else {
      // Ordenar por fecha programada (las más próximas primero)
      tareasOtras.sort((a, b) => new Date(a.fechaProgramada) - new Date(b.fechaProgramada));
      
      contenedorOtras.innerHTML = tareasOtras.map(t => {
        const fechaTarea = new Date(t.fechaProgramada + 'T00:00:00');
        const esVencida = fechaTarea < hoy;
        const fechaFmt = fechaTarea.toLocaleDateString('es-AR', {
          day: '2-digit', month: 'short'
        });
        const badgeVencida = esVencida ? `<span style="color: #c0392b; font-weight: 900;">[VENCIDA]</span> ` : '';
        return `
          <div class="tarea-item-inicio">
            <div class="tarea-info-inicio">
              <span class="tarea-nombre-inicio">${badgeVencida}📅 ${t.tarea}</span>
              <div class="tarea-fecha-inicio">Fecha: <strong>${fechaFmt}</strong> | Ámbito: ${t.ambito}</div>
            </div>
            <button type="button" class="btn-marcar-hecho" onclick="completarTareaManejo('${t.id}')">✔️</button>
          </div>`;
      }).join('');
    }

  } catch (error) {
    console.error('[Agenda] ❌ Error al actualizar alertas:', error);
  }
};

/**
 * Calcula en tiempo real los totales del inventario local (sexo, castrados, categorías)
 * y los plasma en el Tablero de Control de Inicio.
 */
function actualizarContadores() {
  const total = animalesCache.length;
  const hembras = animalesCache.filter(a => a.sexo === 'Hembra').length;
  const machos = animalesCache.filter(a => a.sexo === 'Macho').length;
  const castrados = animalesCache.filter(a => a.castrado).length;

  const ovejas = animalesCache.filter(a => a.sexo === 'Hembra' && a.categoria && a.categoria.includes('Oveja Adulta')).length;
  const carneros = animalesCache.filter(a => a.sexo === 'Macho' && a.categoria && a.categoria.includes('Oveja Adulta / Carnero')).length;
  const borregos = animalesCache.filter(a => a.categoria && a.categoria.includes('Borrego')).length;
  const corderos = animalesCache.filter(a => a.categoria && a.categoria.includes('Cordero')).length;

  const setTexto = (id, valor) => {
    const el = document.getElementById(id);
    if (el) el.textContent = valor;
  };

  setTexto('totalAnimales', total);
  setTexto('totalHembras', hembras);
  setTexto('totalMachos', machos);
  setTexto('totalCastrados', castrados);
  setTexto('totalOvejas', ovejas);
  setTexto('totalCarneros', carneros);
  setTexto('totalBorregos', borregos);
  setTexto('totalCorderos', corderos);
}


/* ============================================================
   MÓDULO 11: REGISTRO DEL SERVICE WORKER (PWA)
   Registra el SW para habilitar el modo Offline-First.
============================================================ */


/* ============================================================
   MÓDULO 12: SELECTORES DINÁMICOS DE ANIMALES
   Rellena automáticamente los <select> de Salud y Tareas
   con los animales del inventario de Firestore.
   Se ejecuta cada vez que la colección 'animales' cambia.
============================================================ */

/**
 * Limpia y repobla los selectores de animales de Salud y Tareas.
 * Cada opción tiene "Caravana: [Nro] - [Nombre]"
 *
 * @param {Array} animales - Array de animales activos de Firestore.
 */
function actualizarSelectoresAnimales(animales) {
  const ids = ['select-caravana-salud', 'select-caravana-tareas'];

  ids.forEach((selectId) => {
    const select = document.getElementById(selectId);
    if (!select) return;

    // Limpiar las opciones previas y agregar el placeholder por defecto
    select.innerHTML = '<option value="">Seleccione un animal...</option>';

    if (!animales || animales.length === 0) return;

    // Ordenar alfabéticamente por número de caravana
    const ordenados = [...animales].sort((a, b) =>
      (a.caravana_id || '').localeCompare(b.caravana_id || '')
    );

    // Crear una <option> por cada animal: "Caravana: AR-001 - Juanito"
    ordenados.forEach((animal) => {
      const caravana = animal.caravana_id || '';
      const nombre   = animal.nombre || 'Sin Nombre';
      const option   = document.createElement('option');
      option.value       = caravana; // caravana como value
      option.textContent = `Caravana: ${caravana} - ${nombre}`;
      select.appendChild(option);
    });

    console.log(`[Selectores] ✅ ${selectId} actualizado con ${ordenados.length} animales.`);
  });
}


/* ============================================================
   MÓDULO 13: VALIDACIÓN DE DISPONIBILIDAD DE jsPDF
   Verifica que la librería esté cargada antes de exportar.
   Si no está disponible, intenta recargarla dinámicamente.
============================================================ */

/**
 * Verifica que window.jspdf esté correctamente definido.
 * Si no lo está, intenta cargar el script de CDN dinámicamente.
 *
 * @returns {Promise<boolean>} true si jsPDF está listo para usar.
 */
async function verificarJsPDF() {
  // Caso 1: Ya está disponible — continuar normalmente
  if (window.jspdf && typeof window.jspdf.jsPDF === 'function') {
    return true;
  }

  console.warn('[PDF] ⚠️ window.jspdf no definido. Intentando recarga dinámica...');

  // Caso 2: No disponible — intentar inyectar los scripts dinámicamente
  return new Promise((resolve) => {
    const script1 = document.createElement('script');
    script1.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
    script1.onload = () => {
      const script2 = document.createElement('script');
      script2.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js';
      script2.onload = () => {
        console.log('[PDF] ✅ jsPDF recargado dinámicamente con éxito.');
        resolve(true);
      };
      script2.onerror = () => {
        console.error('[PDF] ❌ No se pudo cargar jspdf-autotable dinámicamente.');
        resolve(false);
      };
      document.head.appendChild(script2);
    };
    script1.onerror = () => {
      console.error('[PDF] ❌ No se pudo cargar jsPDF dinámicamente. ¿Sin conexión?');
      resolve(false);
    };
    document.head.appendChild(script1);
  });
}

/**
 * Obtiene los datos del predio/productor desde el DOM o Firestore.
 * Se usa como encabezado en todos los PDFs generados.
 *
 * @returns {{productor: string, establecimiento: string}}
 */
function obtenerDatosEncabezado() {
  const productor      = document.getElementById('input-productor')?.value?.trim()       || 'No registrado';
  const establecimiento = document.getElementById('input-establecimiento')?.value?.trim() || 'No registrado';
  return { productor, establecimiento };
}


/* ============================================================
   MÓDULO 14: EXPORTACIÓN PDF — FICHA INDIVIDUAL DEL ANIMAL
   Genera un PDF A4 Portrait con todos los datos del animal
   y sus historiales (Sanidad y Tareas) usando jsPDF + autoTable.
============================================================ */

/**
 * Variable global que almacena el ID del documento del animal
 * que está actualmente abierto en el modal.
 * Se actualiza en abrirModalAnimal() para que el botón PDF sepa
 * a qué animal exportar.
 *
 * @type {string|null}
 */
let modalAnimalDocIdActual = null;

/**
 * Exporta la ficha completa de un animal individual a PDF (A4 Portrait).
 *
 * Incluye:
 *   - Encabezado con productor, establecimiento y fecha de exportación
 *   - Datos identificatorios del animal (caravana, raza, categoría, etc.)
 *   - Edad calculada automáticamente
 *   - Historial sanitario en tabla
 *   - Historial de tareas vinculadas en tabla
 *   - Paginación automática
 *
 * @param {string} docId - ID del documento del animal en Firestore.
 */
window.exportarFichaIndividual = async function(docId) {
  if (!docId) {
    mostrarToast('⚠️ No hay animal seleccionado para exportar.', 'error');
    return;
  }

  // Verificar que jsPDF esté disponible (con recarga dinámica si es necesario)
  const jsPDFDisponible = await verificarJsPDF();
  if (!jsPDFDisponible) {
    mostrarToast('Error al generar el PDF, intente nuevamente.', 'error');
    return;
  }

  try {
    mostrarToast('⏳ Generando ficha PDF...', 'info', 4000);

    // ── 1. Obtener datos del animal desde Firestore ──
    const docSnap = await db.collection('animales').doc(docId).get();
    if (!docSnap.exists) {
      mostrarToast('Animal no encontrado. No se puede exportar.', 'error');
      return;
    }
    const a = docSnap.data();

    // ── 2. Obtener datos del encabezado (Módulo Inicio) ──
    const { productor, establecimiento } = obtenerDatosEncabezado();
    const fechaExportacion = new Date().toLocaleString('es-AR', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });

    // ── 3. Inicializar jsPDF (A4, Portrait, milímetros) ──
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF('p', 'mm', 'a4');

    const margen  = 15;
    const ancho   = doc.internal.pageSize.getWidth();
    let y = margen; // Cursor vertical actual

    // ── 4. ENCABEZADO DEL DOCUMENTO ──
    // Barra de color verde-brand
    doc.setFillColor(46, 125, 50);
    doc.rect(0, 0, ancho, 28, 'F');

    doc.setTextColor(255, 255, 255);
    doc.setFontSize(18);
    doc.setFont('helvetica', 'bold');
    doc.text('OvIAgro — Ficha Individual del Animal', margen, 12);

    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    doc.text(`Productor: ${productor}   |   Establecimiento: ${establecimiento}`, margen, 20);
    doc.text(`Fecha de exportación: ${fechaExportacion}`, margen, 26);

    y = 36;
    doc.setTextColor(0, 0, 0);

    // ── 5. SECCIÓN: IDENTIFICACIÓN ──
    doc.setFontSize(12);
    doc.setFont('helvetica', 'bold');
    doc.setFillColor(232, 245, 233);
    doc.rect(margen, y, ancho - margen * 2, 7, 'F');
    doc.text('🐑 IDENTIFICACIÓN DEL ANIMAL', margen + 2, y + 5);
    y += 10;

    // Mapear datos del animal
    const castradoTexto  = a.castrado ? 'Sí' : 'No';
    const fechaNac       = a.fecha_nacimiento || null;
    const edadCalculada  = calcularEdadAnimal(fechaNac);
    const fechaNacFmt    = fechaNac
      ? new Date(fechaNac + 'T00:00:00').toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' })
      : 'No registrada';

    // Tabla de datos identificatorios (dos columnas)
    doc.autoTable({
      startY: y,
      margin: { left: margen, right: margen },
      theme: 'grid',
      styles: { fontSize: 10, cellPadding: 3, textColor: [20, 20, 20] },
      headStyles: { fillColor: [46, 125, 50], textColor: [255, 255, 255], fontStyle: 'bold' },
      columnStyles: { 0: { fontStyle: 'bold', fillColor: [248, 255, 248], cellWidth: 55 } },
      body: [
        ['Nº de Caravana',  a.caravana_id    || '—'],
        ['Nombre',          a.nombre          || '—'],
        ['Sexo',            a.sexo            || '—'],
        ['Castrado/a',      castradoTexto],
        ['Raza',            a.raza            || '—'],
        ['Categoría',       a.categoria       || '—'],
        ['Fecha Nacimiento',fechaNacFmt],
        ['Edad Actual',     edadCalculada],
        ['Peso Nac. (Kg)',  a.peso_nacimiento ? `${a.peso_nacimiento} Kg` : '—'],
        ['Peso Destete (Kg)', a.peso_destete  ? `${a.peso_destete} Kg`   : '—'],
        ['Caravana Madre',  a.caravana_madre  || '—'],
        ['Caravana Padre',  a.caravana_padre  || '—'],
      ],
    });

    y = doc.lastAutoTable.finalY + 8;

    // ── 6. HISTORIAL SANITARIO ──
    doc.setFontSize(12);
    doc.setFont('helvetica', 'bold');
    doc.setFillColor(227, 242, 253);
    doc.rect(margen, y, ancho - margen * 2, 7, 'F');
    doc.setTextColor(13, 71, 161);
    doc.text('💉 HISTORIAL SANITARIO', margen + 2, y + 5);
    y += 10;
    doc.setTextColor(0, 0, 0);

    const histSan = Array.isArray(a.historial_sanitario) ? a.historial_sanitario : [];
    const sanOrdenado = [...histSan].sort((x, b) => new Date(b.fecha || 0) - new Date(x.fecha || 0));

    if (sanOrdenado.length === 0) {
      doc.autoTable({
        startY: y,
        margin: { left: margen, right: margen },
        theme: 'grid',
        body: [['Sin registros sanitarios o tareas hasta la fecha']],
        styles: { textColor: [150, 150, 150], fontStyle: 'italic', halign: 'center' },
      });
    } else {
      doc.autoTable({
        startY: y,
        margin: { left: margen, right: margen },
        theme: 'striped',
        styles: { fontSize: 9, cellPadding: 2.5 },
        headStyles: { fillColor: [13, 71, 161], textColor: [255, 255, 255], fontStyle: 'bold' },
        head: [['Fecha', 'Evento', 'Producto', 'Dosis', 'Vía', 'Famacha']],
        body: sanOrdenado.map(r => [
          formatearFecha(r.fecha),
          r.tipo_evento      || '—',
          r.producto         || '—',
          r.dosis            || '—',
          r.via_administracion || '—',
          r.famacha ? `${r.famacha}` : '—',
        ]),
      });
    }

    y = doc.lastAutoTable.finalY + 8;

    // ── 7. HISTORIAL DE TAREAS ──
    // Buscar en Firestore las tareas vinculadas a esta caravana
    let tareasAnimal = [];
    try {
      const snapTar = await db.collection('tareas')
        .where('operario_uid', '==', usuarioActual.uid)
        .where('ambito', '==', a.caravana_id || '')
        .get();
      tareasAnimal = snapTar.docs.map(d => d.data());
      tareasAnimal.sort((x, b) => new Date(b.fechaProgramada || 0) - new Date(x.fechaProgramada || 0));
    } catch (e) {
      console.warn('[PDF] No se pudieron cargar tareas para la ficha:', e.message);
    }

    doc.setFontSize(12);
    doc.setFont('helvetica', 'bold');
    doc.setFillColor(255, 243, 224);
    doc.rect(margen, y, ancho - margen * 2, 7, 'F');
    doc.setTextColor(230, 81, 0);
    doc.text('📋 HISTORIAL DE TAREAS DE MANEJO', margen + 2, y + 5);
    y += 10;
    doc.setTextColor(0, 0, 0);

    if (tareasAnimal.length === 0) {
      doc.autoTable({
        startY: y,
        margin: { left: margen, right: margen },
        theme: 'grid',
        body: [['Sin registros sanitarios o tareas hasta la fecha']],
        styles: { textColor: [150, 150, 150], fontStyle: 'italic', halign: 'center' },
      });
    } else {
      doc.autoTable({
        startY: y,
        margin: { left: margen, right: margen },
        theme: 'striped',
        styles: { fontSize: 9, cellPadding: 2.5 },
        headStyles: { fillColor: [230, 81, 0], textColor: [255, 255, 255], fontStyle: 'bold' },
        head: [['Fecha Programada', 'Tarea', 'Ámbito', 'Estado', 'Observaciones']],
        body: tareasAnimal.map(t => [
          t.fechaProgramada || '—',
          t.tarea           || '—',
          t.ambito          || '—',
          t.completada ? 'Completada' : 'Pendiente',
          t.observaciones   || '—',
        ]),
      });
    }

    // ── 8. PIE DE PÁGINA con número de página ──
    const totalPaginas = doc.internal.getNumberOfPages();
    for (let i = 1; i <= totalPaginas; i++) {
      doc.setPage(i);
      doc.setFontSize(8);
      doc.setTextColor(150, 150, 150);
      doc.text(
        `Página ${i} de ${totalPaginas}  |  OvIAgro — ${fechaExportacion}`,
        margen,
        doc.internal.pageSize.getHeight() - 8
      );
    }

    // ── 9. Generar nombre del archivo y disparar descarga ──
    const caravanaLimpia = (a.caravana_id || 'animal').replace(/[^a-zA-Z0-9-]/g, '_');
    const nombreArchivo  = `OvIAgro_Ficha_${caravanaLimpia}.pdf`;
    doc.save(nombreArchivo);

    mostrarToast(`✅ Ficha de ${a.caravana_id} exportada con éxito.`, 'exito', 4000);
    console.log(`[PDF] ✅ Ficha individual exportada: ${nombreArchivo}`);

  } catch (error) {
    console.error('[PDF] ❌ Error al generar la ficha PDF:', error);
    mostrarToast('Error al generar el PDF, intente nuevamente.', 'error', 5000);
  }
};


/* ============================================================
   MÓDULO 15: EXPORTACIÓN PDF — INVENTARIO GENERAL
   Genera un PDF A4 Landscape con todos los animales activos
   del inventario. Encabezado profesional y paginación.
============================================================ */

/**
 * Exporta el inventario completo de animales a PDF (A4 Landscape).
 *
 * Incluye:
 *   - Encabezado con productor, establecimiento, fecha y total
 *   - Tabla con columnas distribuidas: Caravana, Sexo, Raza, etc.
 *   - Paginación automática "Página X de Y" en el pie de página
 *   - Prevención de desbordamiento de columnas con orientación horizontal
 */
window.exportarInventarioGeneral = async function() {
  if (!usuarioActual) {
    mostrarToast('Sesión no iniciada. Recargá la app.', 'error');
    return;
  }

  // Verificar disponibilidad de jsPDF
  const jsPDFDisponible = await verificarJsPDF();
  if (!jsPDFDisponible) {
    mostrarToast('Error al generar el PDF, intente nuevamente.', 'error');
    return;
  }

  try {
    mostrarToast('⏳ Generando inventario PDF...', 'info', 5000);

    // Usar la caché en memoria (ya cargada por onSnapshot)
    const inventario = [...animalesCache].sort((a, b) =>
      (a.caravana_id || '').localeCompare(b.caravana_id || '')
    );

    if (inventario.length === 0) {
      mostrarToast('⚠️ No hay animales en el inventario para exportar.', 'error');
      return;
    }

    // ── Datos del encabezado ──
    const { productor, establecimiento } = obtenerDatosEncabezado();
    const fechaExportacion = new Date().toLocaleString('es-AR', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });

    // ── Inicializar jsPDF en modo Landscape (horizontal) ──
    // Landscape previene el desbordamiento de columnas en tablas anchas.
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF('l', 'mm', 'a4'); // 'l' = landscape

    const margen = 12;
    const ancho  = doc.internal.pageSize.getWidth();  // ~297mm en A4 landscape

    // ── ENCABEZADO PROFESIONAL ──
    doc.setFillColor(46, 125, 50);
    doc.rect(0, 0, ancho, 26, 'F');

    doc.setTextColor(255, 255, 255);
    doc.setFontSize(16);
    doc.setFont('helvetica', 'bold');
    doc.text('OvIAgro — Inventario Completo de Hacienda', margen, 11);

    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    doc.text(`Productor: ${productor}   |   Establecimiento: ${establecimiento}   |   Total: ${inventario.length} animales`, margen, 18);
    doc.text(`Fecha de exportación: ${fechaExportacion}`, margen, 24);

    doc.setTextColor(0, 0, 0);

    // ── TABLA PRINCIPAL con autoTable ──
    doc.autoTable({
      startY: 30,
      margin: { left: margen, right: margen },
      theme: 'striped',
      styles: {
        fontSize: 8.5,
        cellPadding: 3,
        textColor: [20, 20, 20],
        overflow: 'linebreak',
      },
      headStyles: {
        fillColor:  [27, 94, 32],
        textColor:  [255, 255, 255],
        fontStyle:  'bold',
        fontSize:   9,
      },
      alternateRowStyles: { fillColor: [240, 255, 240] },
      // Columnas bien distribuidas para no desbordar en A4 landscape
      columnStyles: {
        0: { cellWidth: 35 }, // Nº Caravana
        1: { cellWidth: 20 }, // Sexo
        2: { cellWidth: 35 }, // Raza
        3: { cellWidth: 45 }, // Categoría
        4: { cellWidth: 30 }, // Fecha Nac.
        5: { cellWidth: 55 }, // Pesos
        6: { cellWidth: 55 }, // Padres
      },
      head: [['Nº Caravana', 'Sexo', 'Raza', 'Categoría', 'Fecha Nac.', 'Pesos', 'Padres']],
      body: inventario.map(a => [
        a.caravana_id || '—',
        a.sexo        || '—',
        a.raza        || '—',
        a.categoria   || '—',
        a.fecha_nacimiento
          ? new Date(a.fecha_nacimiento + 'T00:00:00').toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' })
          : '—',
        `Nac: ${a.peso_nacimiento || '—'} Kg / Dest: ${a.peso_destete || '—'} Kg`,
        `Madre: ${a.caravana_madre || '—'} / Padre: ${a.caravana_padre || '—'}`,
      ]),
      // Hook: paginación automática "Página X de Y" en el pie de cada página
      didDrawPage: (data) => {
        const totalPaginas = doc.internal.getNumberOfPages();
        const paginaActual = doc.internal.getCurrentPageInfo().pageNumber;
        doc.setFontSize(8);
        doc.setTextColor(160, 160, 160);
        doc.text(
          `Página ${paginaActual} de ${totalPaginas}  |  OvIAgro — ${fechaExportacion}  |  ${establecimiento}`,
          margen,
          doc.internal.pageSize.getHeight() - 6
        );
        doc.setTextColor(0, 0, 0);
      },
    });

    // ── Disparar descarga del archivo ──
    const fecha = new Date().toISOString().slice(0, 10);
    const nombreArchivo = `OvIAgro_Inventario_${fecha}.pdf`;
    doc.save(nombreArchivo);

    mostrarToast(`✅ Inventario (${inventario.length} animales) exportado con éxito.`, 'exito', 5000);
    console.log(`[PDF] ✅ Inventario general exportado: ${nombreArchivo}`);

  } catch (error) {
    console.error('[PDF] ❌ Error al generar el inventario PDF:', error);
    mostrarToast('Error al generar el PDF, intente nuevamente.', 'error', 5000);
  }
};

/**
 * Función provisional para la edición de animales en el inventario.
 * @param {string} docId - ID del documento del animal.
 */
window.editarAnimal = function(docId) {
  mostrarToast('ℹ️ Función de edición en desarrollo.', 'info');
};



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

  // 6. Inicializar el modal de detalle completo del animal (Ojo)
  // Conecta el botón X, el overlay de cierre y las pestañas de historiales.
  inicializarModal();

  // 7. Conectar botones de exportación PDF
  document.getElementById('btn-exportar-inventario-pdf')?.addEventListener('click', () => {
    exportarInventarioGeneral();
  });
  document.getElementById('btn-exportar-ficha-pdf')?.addEventListener('click', () => {
    if (modalAnimalDocIdActual) {
      exportarFichaIndividual(modalAnimalDocIdActual);
    } else {
      mostrarToast('⚠️ No hay animal seleccionado para exportar.', 'error');
    }
  });

  // 8. Cargar contadores iniciales vacíos
  actualizarContadores();

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

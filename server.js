const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");

let Pool = null;

try {
  Pool = require("pg").Pool;
} catch (error) {
  console.log("⚠️ Paquete pg no instalado. La app usará recompensas.json temporalmente.");
}

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
  },
});

// 🧠 Memoria de pedidos
let pedidos = [];

// 🛰️ Última ubicación reciente de cada repartidor.
// Solo se usa como respaldo para que el cliente vea ubicación al aceptar un pedido.
const GPS_REPARTIDOR_RECIENTE_MS = 2 * 60 * 1000;
let ultimasUbicacionesRepartidores = {};

// ⭐ Archivo simple de respaldo para recompensas
const RECOMPENSAS_FILE = path.join(__dirname, "recompensas.json");

function cargarRecompensas() {
  try {
    if (fs.existsSync(RECOMPENSAS_FILE)) {
      return JSON.parse(fs.readFileSync(RECOMPENSAS_FILE, "utf8"));
    }
  } catch (error) {
    console.log("⚠️ No se pudieron cargar recompensas:", error.message);
  }

  return {};
}

function guardarRecompensas() {
  try {
    fs.writeFileSync(
      RECOMPENSAS_FILE,
      JSON.stringify(recompensas, null, 2),
      "utf8"
    );
  } catch (error) {
    console.log("⚠️ No se pudieron guardar recompensas:", error.message);
  }
}

let recompensas = cargarRecompensas();

// 💰 Archivo simple de respaldo para entregas de repartidores
const ENTREGAS_REPARTIDOR_FILE = path.join(__dirname, "entregas_repartidor.json");

function cargarEntregasRepartidor() {
  try {
    if (fs.existsSync(ENTREGAS_REPARTIDOR_FILE)) {
      return JSON.parse(fs.readFileSync(ENTREGAS_REPARTIDOR_FILE, "utf8"));
    }
  } catch (error) {
    console.log("⚠️ No se pudieron cargar entregas de repartidores:", error.message);
  }

  return [];
}

function guardarEntregasRepartidor() {
  try {
    fs.writeFileSync(
      ENTREGAS_REPARTIDOR_FILE,
      JSON.stringify(entregasRepartidor, null, 2),
      "utf8"
    );
  } catch (error) {
    console.log("⚠️ No se pudieron guardar entregas de repartidores:", error.message);
  }
}

let entregasRepartidor = cargarEntregasRepartidor();

// 🏪 Archivo simple de respaldo para abrir/cerrar negocios
const NEGOCIOS_ESTADO_FILE = path.join(__dirname, "negocios_estado.json");

function cargarEstadoNegociosLocal() {
  try {
    if (fs.existsSync(NEGOCIOS_ESTADO_FILE)) {
      return JSON.parse(fs.readFileSync(NEGOCIOS_ESTADO_FILE, "utf8"));
    }
  } catch (error) {
    console.log("⚠️ No se pudo cargar estado de negocios:", error.message);
  }

  return {};
}

function guardarEstadoNegociosLocal() {
  try {
    fs.writeFileSync(
      NEGOCIOS_ESTADO_FILE,
      JSON.stringify(estadoNegociosLocal, null, 2),
      "utf8"
    );
  } catch (error) {
    console.log("⚠️ No se pudo guardar estado de negocios:", error.message);
  }
}

let estadoNegociosLocal = cargarEstadoNegociosLocal();

// 🕒 Horarios automáticos de negocios (hora de Chiapas / México)
const HORARIOS_NEGOCIOS = {
  "pasteleria-oscarin": [
    { dias: [0, 1, 2, 3, 4, 5, 6], abre: "08:00", cierra: "20:00" },
  ],
  "antojitos-la-bendicion-de-dios": [
    { dias: [0, 1, 2, 3, 4, 5, 6], abre: "17:00", cierra: "23:30" },
  ],
  "cockteleria-la-almeja-2": [
    { dias: [0, 1, 3, 4, 5, 6], abre: "12:00", cierra: "18:00" },
  ],
  "tortas-el-guero": [
    { dias: [0, 1, 2, 3, 4, 5, 6], abre: "07:30", cierra: "23:00" },
  ],
  "monsis-fresas": [
    { dias: [0, 2, 3, 4, 5, 6], abre: "16:00", cierra: "21:00" },
  ],
  "cocteleria-juanito": [
    { dias: [0, 1, 2, 3, 4, 5, 6], abre: "10:00", cierra: "20:00" },
  ],
  "papeleria-las-gueras": [
    { dias: [1, 2, 3, 4, 5], abre: "08:00", cierra: "20:00" },
    { dias: [0, 6], abre: "08:00", cierra: "16:00" },
  ],
  "el-carboncito": [
    { dias: [0, 1, 2, 3, 4, 5, 6], abre: "16:00", cierra: "00:30" },
  ],
  "consgali": [
    { dias: [0, 1, 2, 3, 4, 5, 6], abre: "18:00", cierra: "23:30" },
  ],
};

function horaAMinutos(hora = "00:00") {
  const [horas, minutos] = String(hora).split(":").map(Number);
  return (horas || 0) * 60 + (minutos || 0);
}

function obtenerAhoraMexico() {
  const partes = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Mexico_City",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());

  const mapa = {};
  partes.forEach((parte) => {
    mapa[parte.type] = parte.value;
  });

  const dias = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };

  return {
    dia: dias[mapa.weekday] ?? new Date().getDay(),
    minutos: Number(mapa.hour || 0) * 60 + Number(mapa.minute || 0),
  };
}

function calcularAbiertoPorHorario(negocioId) {
  const horarios = HORARIOS_NEGOCIOS[String(negocioId || "").trim()] || [];

  if (horarios.length === 0) {
    return true;
  }

  const ahora = obtenerAhoraMexico();
  let abierto = false;

  horarios
    .filter((horario) => Array.isArray(horario.dias) && horario.dias.includes(ahora.dia))
    .forEach((horario) => {
      const abre = horaAMinutos(horario.abre);
      const cierra = horaAMinutos(horario.cierra);

      if (cierra < abre) {
        if (ahora.minutos >= abre || ahora.minutos < cierra) abierto = true;
        return;
      }

      if (ahora.minutos >= abre && ahora.minutos < cierra) abierto = true;
    });

  return abierto;
}


const DATABASE_URL = process.env.DATABASE_URL;
let pool = null;
let baseDatosLista = false;

if (DATABASE_URL && Pool) {
  const poolConfig = {
    connectionString: DATABASE_URL,
  };

  // Si alguna URL externa trae sslmode=require, activamos SSL.
  if (DATABASE_URL.includes("sslmode=require")) {
    poolConfig.ssl = {
      rejectUnauthorized: false,
    };
  }

  pool = new Pool(poolConfig);
}

function crearRecompensaVacia() {
  return {
    pedidosCompletados: 0,
    meta: 10,
    recompensaDisponible: false,
    pedidosContados: [],
    fechaActualizacion: null,
  };
}

function normalizarRecompensaDesdeDB(row, pedidosContados = []) {
  return {
    pedidosCompletados: Number(row.pedidos_completados || 0),
    meta: Number(row.meta || 10),
    recompensaDisponible: Boolean(row.recompensa_disponible),
    pedidosContados,
    fechaActualizacion: row.fecha_actualizacion,
  };
}

async function inicializarBaseDatos() {
  if (!pool) {
    console.log("⚠️ DATABASE_URL no disponible o pg no instalado. Usando recompensas.json.");
    return;
  }

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS recompensas (
        cliente_id TEXT PRIMARY KEY,
        pedidos_completados INTEGER NOT NULL DEFAULT 0,
        meta INTEGER NOT NULL DEFAULT 10,
        recompensa_disponible BOOLEAN NOT NULL DEFAULT FALSE,
        fecha_actualizacion TIMESTAMPTZ
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS recompensa_pedidos_contados (
        cliente_id TEXT NOT NULL REFERENCES recompensas(cliente_id) ON DELETE CASCADE,
        pedido_id TEXT NOT NULL,
        fecha_contado TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (cliente_id, pedido_id)
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS clientes (
        cliente_id TEXT PRIMARY KEY,
        telefono TEXT UNIQUE NOT NULL,
        nombre TEXT,
        pin_hash TEXT NOT NULL,
        fecha_creacion TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
        await pool.query(`
      CREATE TABLE IF NOT EXISTS pedidos (
        id TEXT PRIMARY KEY,
        cliente_id TEXT NOT NULL,
        estado TEXT NOT NULL DEFAULT 'pendiente',
        data JSONB NOT NULL,
        fecha_creacion TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        fecha_actualizacion TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS pedidos_cliente_id_idx
      ON pedidos(cliente_id);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS pedidos_fecha_actualizacion_idx
      ON pedidos(fecha_actualizacion DESC);
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS entregas_repartidor (
        pedido_id TEXT PRIMARY KEY,
        repartidor_id TEXT NOT NULL,
        repartidor_nombre TEXT NOT NULL,
        cliente_nombre TEXT,
        zona TEXT,
        costo TEXT,
        comision_dueno INTEGER NOT NULL DEFAULT 10,
        fecha_entrega TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS entregas_repartidor_fecha_idx
      ON entregas_repartidor(fecha_entrega DESC);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS entregas_repartidor_repartidor_idx
      ON entregas_repartidor(repartidor_id);
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS repartidores_estado (
        repartidor_id TEXT PRIMARY KEY,
        repartidor_nombre TEXT NOT NULL,
        disponible BOOLEAN NOT NULL DEFAULT TRUE,
        fecha_actualizacion TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    for (const repartidor of REPARTIDORES) {
      await pool.query(
        `
        INSERT INTO repartidores_estado (
          repartidor_id,
          repartidor_nombre,
          disponible,
          fecha_actualizacion
        )
        VALUES ($1, $2, TRUE, NOW())
        ON CONFLICT (repartidor_id) DO UPDATE
        SET repartidor_nombre = EXCLUDED.repartidor_nombre;
        `,
        [repartidor.id, repartidor.nombre]
      );
    }

    await pool.query(`
      CREATE TABLE IF NOT EXISTS negocios_estado (
        negocio_id TEXT PRIMARY KEY,
        negocio_nombre TEXT NOT NULL,
        abierto BOOLEAN NOT NULL DEFAULT TRUE,
        fecha_actualizacion TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await pool.query(`
      ALTER TABLE negocios_estado
      ADD COLUMN IF NOT EXISTS modo TEXT NOT NULL DEFAULT 'auto';
    `);

    baseDatosLista = true;
    console.log("✅ Base de datos PostgreSQL lista para recompensas y clientes.");
  } catch (error) {
    baseDatosLista = false;
    console.log("⚠️ No se pudo inicializar PostgreSQL. Usando recompensas.json:", error.message);
  }
}

function obtenerRecompensaClienteLocal(clienteId) {
  if (!clienteId) return null;

  if (!recompensas[clienteId]) {
    recompensas[clienteId] = crearRecompensaVacia();
    guardarRecompensas();
  }

  return recompensas[clienteId];
}

async function obtenerRecompensaCliente(clienteId) {
  if (!clienteId) return null;

  if (!baseDatosLista) {
    return obtenerRecompensaClienteLocal(clienteId);
  }

  try {
    await pool.query(
      `
      INSERT INTO recompensas (cliente_id)
      VALUES ($1)
      ON CONFLICT (cliente_id) DO NOTHING;
      `,
      [clienteId]
    );

    const recompensaResult = await pool.query(
      `
      SELECT cliente_id, pedidos_completados, meta, recompensa_disponible, fecha_actualizacion
      FROM recompensas
      WHERE cliente_id = $1;
      `,
      [clienteId]
    );

    const pedidosResult = await pool.query(
      `
      SELECT pedido_id
      FROM recompensa_pedidos_contados
      WHERE cliente_id = $1
      ORDER BY fecha_contado ASC;
      `,
      [clienteId]
    );

    const pedidosContados = pedidosResult.rows.map((row) =>
      String(row.pedido_id)
    );

    return normalizarRecompensaDesdeDB(
      recompensaResult.rows[0],
      pedidosContados
    );
  } catch (error) {
    console.log("⚠️ Error consultando recompensa en DB:", error.message);
    return obtenerRecompensaClienteLocal(clienteId);
  }
}

async function obtenerRecompensaPublica(clienteId) {
  const recompensa = await obtenerRecompensaCliente(clienteId);

  if (!recompensa) return null;

  return {
    clienteId,
    pedidosCompletados: recompensa.pedidosCompletados,
    meta: recompensa.meta,
    recompensaDisponible: recompensa.recompensaDisponible,
    faltan: Math.max(recompensa.meta - recompensa.pedidosCompletados, 0),
  };
}

async function emitirRecompensaCliente(clienteId) {
  if (!clienteId) return;

  io.to(clienteId).emit(
    "recompensa-actualizada",
    await obtenerRecompensaPublica(clienteId)
  );
}

async function registrarPedidoEntregadoLocal(pedido) {
  if (!pedido?.clienteId || pedido.estado !== "entregado") return;

  const recompensa = obtenerRecompensaClienteLocal(pedido.clienteId);
  const pedidoId = String(pedido.id);

  // Evita sumar el mismo pedido dos veces
  if (recompensa.pedidosContados.includes(pedidoId)) {
    await emitirRecompensaCliente(pedido.clienteId);
    return;
  }

  // Si ya tiene recompensa disponible, dejamos el progreso en 10/10
  // hasta que el cliente use su envío gratis.
  if (recompensa.recompensaDisponible) {
    await emitirRecompensaCliente(pedido.clienteId);
    return;
  }

  recompensa.pedidosContados.push(pedidoId);

  recompensa.pedidosCompletados = Math.min(
    recompensa.pedidosCompletados + 1,
    recompensa.meta
  );

  if (recompensa.pedidosCompletados >= recompensa.meta) {
    recompensa.recompensaDisponible = true;
  }

  recompensa.fechaActualizacion = new Date().toISOString();
  guardarRecompensas();

  await emitirRecompensaCliente(pedido.clienteId);

  console.log("⭐ Recompensa actualizada:", {
    clienteId: pedido.clienteId,
    pedidosCompletados: recompensa.pedidosCompletados,
    recompensaDisponible: recompensa.recompensaDisponible,
    guardadoEn: "recompensas.json",
  });
}

async function registrarPedidoEntregado(pedido) {
  if (!pedido?.clienteId || pedido.estado !== "entregado") return;

  if (!baseDatosLista) {
    await registrarPedidoEntregadoLocal(pedido);
    return;
  }

  const cliente = await pool.connect();
  const clienteId = pedido.clienteId;
  const pedidoId = String(pedido.id);

  try {
    await cliente.query("BEGIN");

    await cliente.query(
      `
      INSERT INTO recompensas (cliente_id)
      VALUES ($1)
      ON CONFLICT (cliente_id) DO NOTHING;
      `,
      [clienteId]
    );

    const recompensaResult = await cliente.query(
      `
      SELECT pedidos_completados, meta, recompensa_disponible
      FROM recompensas
      WHERE cliente_id = $1
      FOR UPDATE;
      `,
      [clienteId]
    );

    const recompensaActual = recompensaResult.rows[0];

    if (recompensaActual.recompensa_disponible) {
      await cliente.query("COMMIT");
      await emitirRecompensaCliente(clienteId);
      return;
    }

    const pedidoContadoResult = await cliente.query(
      `
      INSERT INTO recompensa_pedidos_contados (cliente_id, pedido_id)
      VALUES ($1, $2)
      ON CONFLICT (cliente_id, pedido_id) DO NOTHING
      RETURNING pedido_id;
      `,
      [clienteId, pedidoId]
    );

    // Si no regresó filas, ese pedido ya había sumado punto.
    if (pedidoContadoResult.rows.length === 0) {
      await cliente.query("COMMIT");
      await emitirRecompensaCliente(clienteId);
      return;
    }

    const actualizadoResult = await cliente.query(
      `
      UPDATE recompensas
      SET
        pedidos_completados = LEAST(pedidos_completados + 1, meta),
        recompensa_disponible = (LEAST(pedidos_completados + 1, meta) >= meta),
        fecha_actualizacion = NOW()
      WHERE cliente_id = $1
      RETURNING pedidos_completados, meta, recompensa_disponible;
      `,
      [clienteId]
    );

    await cliente.query("COMMIT");

    await emitirRecompensaCliente(clienteId);

    console.log("⭐ Recompensa actualizada:", {
      clienteId,
      pedidosCompletados: actualizadoResult.rows[0].pedidos_completados,
      recompensaDisponible: actualizadoResult.rows[0].recompensa_disponible,
      guardadoEn: "PostgreSQL",
    });
  } catch (error) {
    await cliente.query("ROLLBACK");
    console.log("⚠️ Error guardando recompensa en DB:", error.message);
    await registrarPedidoEntregadoLocal(pedido);
  } finally {
    cliente.release();
  }
}

async function usarRecompensaClienteLocal(clienteId) {
  const recompensa = obtenerRecompensaClienteLocal(clienteId);

  if (!recompensa?.recompensaDisponible) {
    return {
      ok: false,
      mensaje: "No tienes una recompensa disponible.",
    };
  }

  recompensa.pedidosCompletados = 0;
  recompensa.recompensaDisponible = false;
  recompensa.fechaActualizacion = new Date().toISOString();

  // Importante: NO borramos pedidosContados para evitar que pedidos viejos
  // vuelvan a sumar si se actualizan otra vez.
  guardarRecompensas();
  await emitirRecompensaCliente(clienteId);

  return {
    ok: true,
    mensaje: "Recompensa usada correctamente.",
  };
}

async function usarRecompensaCliente(clienteId) {
  if (!clienteId) {
    return {
      ok: false,
      mensaje: "Cliente no válido.",
    };
  }

  if (!baseDatosLista) {
    return usarRecompensaClienteLocal(clienteId);
  }

  try {
    const resultado = await pool.query(
      `
      UPDATE recompensas
      SET
        pedidos_completados = 0,
        recompensa_disponible = FALSE,
        fecha_actualizacion = NOW()
      WHERE cliente_id = $1
        AND recompensa_disponible = TRUE
      RETURNING cliente_id;
      `,
      [clienteId]
    );

    if (resultado.rows.length === 0) {
      return {
        ok: false,
        mensaje: "No tienes una recompensa disponible.",
      };
    }

    await emitirRecompensaCliente(clienteId);

    return {
      ok: true,
      mensaje: "Recompensa usada correctamente.",
    };
  } catch (error) {
    console.log("⚠️ Error usando recompensa en DB:", error.message);
    return usarRecompensaClienteLocal(clienteId);
  }
}

// 👤 Limpia el teléfono para guardar solo números
function limpiarTelefono(telefono) {
  return String(telefono || "").replace(/\D/g, "");
}

// 🔐 Solo permitimos PIN de 4 a 6 números
function validarPin(pin) {
  return /^\d{4,6}$/.test(String(pin || ""));
}

// 📞 Obtener teléfono del cliente registrado usando su clienteId
async function obtenerTelefonoCliente(clienteId) {
  if (!clienteId || !baseDatosLista || !pool) {
    return "";
  }

  try {
    const resultado = await pool.query(
      `
      SELECT telefono
      FROM clientes
      WHERE cliente_id = $1
      LIMIT 1;
      `,
      [clienteId]
    );

    return limpiarTelefono(resultado.rows[0]?.telefono || "");
  } catch (error) {
    console.log("⚠️ No se pudo obtener teléfono del cliente:", error.message);
    return "";
  }
}

// 🛵 Repartidores autorizados
// Más adelante podemos moverlos a una tabla de PostgreSQL.
// Por ahora quedan aquí para iniciar rápido y seguro.
const REPARTIDORES = [
  { id: "angel", nombre: "Angel", pin: "1003" },
  { id: "eduardo", nombre: "Eduardo", pin: "0909" },
  { id: "chalan", nombre: "Chalan", pin: "2026" },
  { id: "cesar", nombre: "Cesar", pin: "2000" },
  { id: "lex-cortez", nombre: "Lex Cortez", pin: "060396" },
];

// 👑 Dueño autorizado para ver cuentas internas
const DUENO = {
  usuario: "constantino",
  nombre: "Constantino",
  pin: "1998",
};

function validarCredencialesDueno(usuario, pin) {
  return (
    limpiarTextoAcceso(usuario) === limpiarTextoAcceso(DUENO.usuario) &&
    String(pin || "").trim() === DUENO.pin
  );
}

function crearResumenVacioRepartidores() {
  return REPARTIDORES.map((repartidor) => ({
    repartidorId: repartidor.id,
    repartidorNombre: repartidor.nombre,
    entregas: 0,
    totalDueno: 0,
  }));
}

function ordenarResumenRepartidores(resumen) {
  const orden = REPARTIDORES.map((repartidor) => repartidor.id);

  return [...resumen].sort((a, b) => {
    const indexA = orden.indexOf(a.repartidorId);
    const indexB = orden.indexOf(b.repartidorId);

    if (indexA === -1 && indexB === -1) {
      return String(a.repartidorNombre).localeCompare(String(b.repartidorNombre));
    }

    if (indexA === -1) return 1;
    if (indexB === -1) return -1;

    return indexA - indexB;
  });
}

async function obtenerResumenEntregasDueno(fechaConsulta) {
  const fecha = fechaConsulta || obtenerFechaMexico();

  if (!baseDatosLista || !pool) {
    const detalles = entregasRepartidor
      .filter((entrega) => String(entrega.fechaMexico || "").startsWith(fecha))
      .map((entrega) => ({
        pedidoId: entrega.pedidoId,
        repartidorId: entrega.repartidorId,
        repartidorNombre: entrega.repartidorNombre,
        clienteNombre: entrega.clienteNombre || "",
        zona: entrega.zona || "",
        costo: entrega.costo || "",
        comisionDueno: Number(entrega.comisionDueno || 10),
        hora: String(entrega.fechaMexico || "").slice(11, 16),
        fechaEntrega: entrega.fechaEntrega,
      }));

    const resumenMap = new Map();

    crearResumenVacioRepartidores().forEach((item) => {
      resumenMap.set(item.repartidorId, item);
    });

    detalles.forEach((entrega) => {
      if (!resumenMap.has(entrega.repartidorId)) {
        resumenMap.set(entrega.repartidorId, {
          repartidorId: entrega.repartidorId,
          repartidorNombre: entrega.repartidorNombre,
          entregas: 0,
          totalDueno: 0,
        });
      }

      const actual = resumenMap.get(entrega.repartidorId);
      actual.entregas += 1;
      actual.totalDueno += Number(entrega.comisionDueno || 10);
    });

    const resumen = ordenarResumenRepartidores([...resumenMap.values()]);
    const totalGeneral = resumen.reduce((total, item) => total + item.totalDueno, 0);
    const totalEntregas = resumen.reduce((total, item) => total + item.entregas, 0);

    return {
      fecha,
      resumen,
      detalles,
      totalGeneral,
      totalEntregas,
    };
  }

  const resumenResult = await pool.query(
    `
    SELECT
      repartidor_id,
      repartidor_nombre,
      COUNT(*)::int AS entregas,
      COALESCE(SUM(comision_dueno), 0)::int AS total_dueno
    FROM entregas_repartidor
    WHERE (fecha_entrega AT TIME ZONE 'America/Mexico_City')::date = $1::date
    GROUP BY repartidor_id, repartidor_nombre
    ORDER BY repartidor_nombre ASC;
    `,
    [fecha]
  );

  const detallesResult = await pool.query(
    `
    SELECT
      pedido_id,
      repartidor_id,
      repartidor_nombre,
      cliente_nombre,
      zona,
      costo,
      comision_dueno,
      TO_CHAR(fecha_entrega AT TIME ZONE 'America/Mexico_City', 'HH24:MI') AS hora,
      fecha_entrega
    FROM entregas_repartidor
    WHERE (fecha_entrega AT TIME ZONE 'America/Mexico_City')::date = $1::date
    ORDER BY fecha_entrega DESC;
    `,
    [fecha]
  );

  const resumenMap = new Map();

  crearResumenVacioRepartidores().forEach((item) => {
    resumenMap.set(item.repartidorId, item);
  });

  resumenResult.rows.forEach((row) => {
    resumenMap.set(row.repartidor_id, {
      repartidorId: row.repartidor_id,
      repartidorNombre: row.repartidor_nombre,
      entregas: Number(row.entregas || 0),
      totalDueno: Number(row.total_dueno || 0),
    });
  });

  const resumen = ordenarResumenRepartidores([...resumenMap.values()]);

  const detalles = detallesResult.rows.map((row) => ({
    pedidoId: row.pedido_id,
    repartidorId: row.repartidor_id,
    repartidorNombre: row.repartidor_nombre,
    clienteNombre: row.cliente_nombre || "",
    zona: row.zona || "",
    costo: row.costo || "",
    comisionDueno: Number(row.comision_dueno || 10),
    hora: row.hora,
    fechaEntrega: row.fecha_entrega,
  }));

  const totalGeneral = resumen.reduce((total, item) => total + item.totalDueno, 0);
  const totalEntregas = resumen.reduce((total, item) => total + item.entregas, 0);

  return {
    fecha,
    resumen,
    detalles,
    totalGeneral,
    totalEntregas,
  };
}

function limpiarTextoAcceso(valor) {
  return String(valor || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function obtenerRepartidorPorCredenciales(usuario, pin) {
  const usuarioLimpio = limpiarTextoAcceso(usuario);
  const pinLimpio = String(pin || "").trim();

  return REPARTIDORES.find((repartidor) => {
    return (
      (limpiarTextoAcceso(repartidor.id) === usuarioLimpio ||
        limpiarTextoAcceso(repartidor.nombre) === usuarioLimpio) &&
      repartidor.pin === pinLimpio
    );
  });
}

function obtenerRepartidorPorId(repartidorId) {
  const idLimpio = limpiarTextoAcceso(repartidorId);

  return REPARTIDORES.find(
    (repartidor) => limpiarTextoAcceso(repartidor.id) === idLimpio
  );
}

function guardarUltimaUbicacionRepartidor(data, repartidor) {
  const lat = Number(data?.lat);
  const lng = Number(data?.lng);

  if (!repartidor?.id || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }

  const ubicacion = {
    lat,
    lng,
    accuracy: Number.isFinite(Number(data?.accuracy))
      ? Number(data.accuracy)
      : null,
    fecha: data?.fecha || new Date().toISOString(),
    fechaServidor: new Date().toISOString(),
    repartidorId: repartidor.id,
    repartidorNombre: repartidor.nombre,
  };

  ultimasUbicacionesRepartidores[repartidor.id] = ubicacion;

  return ubicacion;
}

function obtenerUltimaUbicacionReciente(repartidorId) {
  const id = String(repartidorId || "").trim();
  const ultima = ultimasUbicacionesRepartidores[id];

  if (!ultima) {
    return null;
  }

  const tiempo = new Date(ultima.fechaServidor || ultima.fecha).getTime();

  if (Number.isNaN(tiempo)) {
    return null;
  }

  if (Date.now() - tiempo > GPS_REPARTIDOR_RECIENTE_MS) {
    return null;
  }

  return ultima;
}

function emitirUltimaUbicacionRepartidorACliente(pedido) {
  if (!pedido?.clienteId || !pedido?.repartidorId) {
    return false;
  }

  const estado = String(pedido.estado || "").toLowerCase();

  if (estado === "cancelado" || estado === "entregado") {
    return false;
  }

  const ultimaUbicacion = obtenerUltimaUbicacionReciente(pedido.repartidorId);

  if (!ultimaUbicacion) {
    return false;
  }

  io.to(String(pedido.clienteId)).emit("repartidor-movimiento", ultimaUbicacion);

  return true;
}

// 🟢 Estado de servicio por repartidor
const ESTADO_REPARTIDORES_FILE = path.join(__dirname, "estado_repartidores.json");

function crearEstadoServicioInicial() {
  return REPARTIDORES.reduce((estado, repartidor) => {
    estado[repartidor.id] = {
      repartidorId: repartidor.id,
      repartidorNombre: repartidor.nombre,
      disponible: true,
      fechaActualizacion: new Date().toISOString(),
    };
    return estado;
  }, {});
}

function cargarEstadoServicioLocal() {
  try {
    if (fs.existsSync(ESTADO_REPARTIDORES_FILE)) {
      const guardado = JSON.parse(fs.readFileSync(ESTADO_REPARTIDORES_FILE, "utf8"));
      return { ...crearEstadoServicioInicial(), ...guardado };
    }
  } catch (error) {
    console.log("⚠️ No se pudo cargar estado de repartidores:", error.message);
  }
  return crearEstadoServicioInicial();
}

function guardarEstadoServicioLocal() {
  try {
    fs.writeFileSync(
      ESTADO_REPARTIDORES_FILE,
      JSON.stringify(estadoServicioRepartidores, null, 2),
      "utf8"
    );
  } catch (error) {
    console.log("⚠️ No se pudo guardar estado de repartidores:", error.message);
  }
}

let estadoServicioRepartidores = cargarEstadoServicioLocal();

function normalizarEstadoServicio(repartidoresEstado) {
  const porId = new Map();
  repartidoresEstado.forEach((item) => porId.set(String(item.repartidorId), item));

  const repartidores = REPARTIDORES.map((repartidor) => {
    const encontrado = porId.get(repartidor.id);

    return {
      repartidorId: repartidor.id,
      repartidorNombre: repartidor.nombre,
      disponible: encontrado?.disponible === undefined ? true : Boolean(encontrado.disponible),
      fechaActualizacion: encontrado?.fechaActualizacion || null,
    };
  });

  const activo = repartidores.some((item) => item.disponible);

  return {
    activo,
    repartidores,
    mensaje: activo
      ? "Servicio disponible."
      : "Por el momento estamos fuera de servicio. Intenta más tarde.",
  };
}

async function obtenerEstadoServicio() {
  if (!baseDatosLista || !pool) {
    return normalizarEstadoServicio(Object.values(estadoServicioRepartidores));
  }

  try {
    const resultado = await pool.query(`
      SELECT repartidor_id, repartidor_nombre, disponible, fecha_actualizacion
      FROM repartidores_estado
      ORDER BY repartidor_nombre ASC;
    `);

    return normalizarEstadoServicio(
      resultado.rows.map((row) => ({
        repartidorId: row.repartidor_id,
        repartidorNombre: row.repartidor_nombre,
        disponible: row.disponible,
        fechaActualizacion: row.fecha_actualizacion,
      }))
    );
  } catch (error) {
    console.log("⚠️ No se pudo consultar estado de servicio:", error.message);
    return normalizarEstadoServicio(Object.values(estadoServicioRepartidores));
  }
}

function obtenerTiempoPedido(pedido) {
  const fechaPedido =
    pedido?.fecha ||
    pedido?.fechaCreacion ||
    pedido?.createdAt ||
    pedido?.fecha_creacion ||
    null;

  const tiempoPorFecha = fechaPedido ? new Date(fechaPedido).getTime() : NaN;

  if (!Number.isNaN(tiempoPorFecha)) {
    return tiempoPorFecha;
  }

  const tiempoPorId = Number(pedido?.id);

  if (Number.isFinite(tiempoPorId)) {
    return tiempoPorId;
  }

  return NaN;
}

async function obtenerEstadoRepartidorServicio(repartidorId) {
  const estado = await obtenerEstadoServicio();

  return estado.repartidores.find(
    (item) => String(item.repartidorId) === String(repartidorId)
  );
}

async function repartidorPuedeAceptarPedido(repartidorId, pedido) {
  const estadoRepartidor = await obtenerEstadoRepartidorServicio(repartidorId);

  if (!estadoRepartidor || estadoRepartidor.disponible !== false) {
    return true;
  }

  const tiempoFueraServicio = new Date(
    estadoRepartidor.fechaActualizacion
  ).getTime();

  const tiempoPedido = obtenerTiempoPedido(pedido);

  if (Number.isNaN(tiempoFueraServicio) || Number.isNaN(tiempoPedido)) {
    return false;
  }

  // Si el pedido cayó antes de que el repartidor se pusiera fuera de servicio,
  // todavía puede aceptarlo para no dejar colgado al cliente.
  return tiempoPedido <= tiempoFueraServicio;
}

async function actualizarEstadoServicioRepartidor(repartidorId, disponible) {
  const repartidor = obtenerRepartidorPorId(repartidorId);

  if (!repartidor) {
    return { ok: false, mensaje: "Repartidor no válido." };
  }

  const disponibleFinal = Boolean(disponible);

  if (!baseDatosLista || !pool) {
    estadoServicioRepartidores[repartidor.id] = {
      repartidorId: repartidor.id,
      repartidorNombre: repartidor.nombre,
      disponible: disponibleFinal,
      fechaActualizacion: new Date().toISOString(),
    };

    guardarEstadoServicioLocal();

    const estado = await obtenerEstadoServicio();
    io.emit("servicio-actualizado", estado);

    return { ok: true, estado };
  }

  try {
    await pool.query(
      `
      INSERT INTO repartidores_estado (
        repartidor_id,
        repartidor_nombre,
        disponible,
        fecha_actualizacion
      )
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (repartidor_id) DO UPDATE
      SET
        repartidor_nombre = EXCLUDED.repartidor_nombre,
        disponible = EXCLUDED.disponible,
        fecha_actualizacion = NOW();
      `,
      [repartidor.id, repartidor.nombre, disponibleFinal]
    );

    const estado = await obtenerEstadoServicio();
    io.emit("servicio-actualizado", estado);

    return { ok: true, estado };
  } catch (error) {
    console.log("⚠️ No se pudo actualizar estado de servicio:", error.message);
    return { ok: false, mensaje: "No se pudo actualizar el estado de servicio." };
  }
}

// 🏪 Estado abierto/cerrado por negocio
function normalizarEstadoNegocios(rows = []) {
  return {
    negocios: rows.map((item) => {
      const negocioId = String(item.negocioId || "").trim();
      const modo = item.modo === "manual" ? "manual" : "auto";
      const abiertoManual = item.abierto !== false;
      const abiertoHorario = calcularAbiertoPorHorario(negocioId);
      const abiertoFinal = modo === "manual" ? abiertoManual : abiertoHorario;

      return {
        negocioId,
        negocioNombre: item.negocioNombre || "",
        abierto: abiertoFinal,
        abiertoManual,
        abiertoHorario,
        modo,
        fechaActualizacion: item.fechaActualizacion || null,
      };
    }),
  };
}

async function obtenerEstadoNegocios() {
  if (!baseDatosLista || !pool) {
    return normalizarEstadoNegocios(Object.values(estadoNegociosLocal));
  }

  try {
    const resultado = await pool.query(`
      SELECT negocio_id, negocio_nombre, abierto, modo, fecha_actualizacion
      FROM negocios_estado
      ORDER BY negocio_nombre ASC;
    `);

    return normalizarEstadoNegocios(
      resultado.rows.map((row) => ({
        negocioId: row.negocio_id,
        negocioNombre: row.negocio_nombre,
        abierto: row.abierto,
        modo: row.modo,
        fechaActualizacion: row.fecha_actualizacion,
      }))
    );
  } catch (error) {
    console.log("⚠️ No se pudo consultar estado de negocios:", error.message);
    return normalizarEstadoNegocios(Object.values(estadoNegociosLocal));
  }
}

async function negocioEstaAbierto(negocioId) {
  const id = String(negocioId || "").trim();

  if (!id) return true;

  const abiertoHorario = calcularAbiertoPorHorario(id);

  if (!baseDatosLista || !pool) {
    const estadoLocal = estadoNegociosLocal[id];
    const modoLocal = estadoLocal?.modo === "manual" ? "manual" : "auto";

    if (modoLocal === "manual") {
      return estadoLocal?.abierto !== false;
    }

    return abiertoHorario;
  }

  try {
    const resultado = await pool.query(
      `
      SELECT abierto, modo
      FROM negocios_estado
      WHERE negocio_id = $1
      LIMIT 1;
      `,
      [id]
    );

    if (resultado.rows.length === 0) {
      return abiertoHorario;
    }

    const row = resultado.rows[0];
    const modo = row.modo === "manual" ? "manual" : "auto";

    if (modo === "manual") {
      return row.abierto !== false;
    }

    return abiertoHorario;
  } catch (error) {
    console.log("⚠️ No se pudo validar negocio abierto:", error.message);
    const estadoLocal = estadoNegociosLocal[id];
    const modoLocal = estadoLocal?.modo === "manual" ? "manual" : "auto";

    if (modoLocal === "manual") {
      return estadoLocal?.abierto !== false;
    }

    return abiertoHorario;
  }
}

async function validarNegociosAbiertos(negociosIds = []) {
  const ids = [...new Set((negociosIds || []).map((id) => String(id || "").trim()).filter(Boolean))];

  for (const id of ids) {
    const abierto = await negocioEstaAbierto(id);

    if (!abierto) {
      return {
        ok: false,
        negocioId: id,
        mensaje: "Este negocio está cerrado por el momento. Intenta más tarde.",
      };
    }
  }

  return { ok: true };
}

async function actualizarEstadoNegocio(negocioId, negocioNombre, abierto, modo = "manual") {
  const id = String(negocioId || "").trim();
  const nombre = String(negocioNombre || id || "Negocio").trim();
  const abiertoFinal = Boolean(abierto);
  const modoFinal = modo === "auto" ? "auto" : "manual";

  if (!id) {
    return {
      ok: false,
      mensaje: "Negocio no válido.",
    };
  }

  if (!baseDatosLista || !pool) {
    estadoNegociosLocal[id] = {
      negocioId: id,
      negocioNombre: nombre,
      abierto: abiertoFinal,
      modo: modoFinal,
      fechaActualizacion: new Date().toISOString(),
    };

    guardarEstadoNegociosLocal();

    const estado = await obtenerEstadoNegocios();
    io.emit("negocios-actualizados", estado);

    return {
      ok: true,
      estado,
    };
  }

  try {
    await pool.query(
      `
      INSERT INTO negocios_estado (
        negocio_id,
        negocio_nombre,
        abierto,
        modo,
        fecha_actualizacion
      )
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (negocio_id) DO UPDATE
      SET
        negocio_nombre = EXCLUDED.negocio_nombre,
        abierto = EXCLUDED.abierto,
        modo = EXCLUDED.modo,
        fecha_actualizacion = NOW();
      `,
      [id, nombre, abiertoFinal, modoFinal]
    );

    const estado = await obtenerEstadoNegocios();
    io.emit("negocios-actualizados", estado);

    return {
      ok: true,
      estado,
    };
  } catch (error) {
    console.log("⚠️ No se pudo actualizar estado de negocio:", error.message);

    return {
      ok: false,
      mensaje: "No se pudo actualizar el estado del negocio.",
    };
  }
}

function obtenerFechaHoraMexico() {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "America/Mexico_City",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date());
}

async function registrarEntregaRepartidorLocal(pedido) {
  if (!pedido?.id || pedido.estado !== "entregado" || !pedido.repartidorId) {
    return;
  }

  const pedidoId = String(pedido.id);

  if (entregasRepartidor.some((entrega) => String(entrega.pedidoId) === pedidoId)) {
    return;
  }

  const repartidor = obtenerRepartidorPorId(pedido.repartidorId);

  if (!repartidor) {
    console.log("⚠️ Repartidor no válido para registrar entrega:", pedido.repartidorId);
    return;
  }

  const entrega = {
    pedidoId,
    repartidorId: repartidor.id,
    repartidorNombre: repartidor.nombre,
    clienteNombre: pedido.nombre || "",
    zona: pedido.zona || "",
    costo: String(pedido.costo || ""),
    comisionDueno: 10,
    fechaEntrega: new Date().toISOString(),
    fechaMexico: obtenerFechaHoraMexico(),
  };

  entregasRepartidor = [entrega, ...entregasRepartidor].slice(0, 1000);
  guardarEntregasRepartidor();

  console.log("💰 Entrega registrada local:", entrega);
}

async function registrarEntregaRepartidor(pedido) {
  if (!pedido?.id || pedido.estado !== "entregado" || !pedido.repartidorId) {
    return;
  }

  const repartidor = obtenerRepartidorPorId(pedido.repartidorId);

  if (!repartidor) {
    console.log("⚠️ Repartidor no válido para registrar entrega:", pedido.repartidorId);
    return;
  }

  if (!baseDatosLista || !pool) {
    await registrarEntregaRepartidorLocal({
      ...pedido,
      repartidorId: repartidor.id,
      repartidorNombre: repartidor.nombre,
    });
    return;
  }

  try {
    const resultado = await pool.query(
      `
      INSERT INTO entregas_repartidor (
        pedido_id,
        repartidor_id,
        repartidor_nombre,
        cliente_nombre,
        zona,
        costo,
        comision_dueno,
        fecha_entrega
      )
      VALUES ($1, $2, $3, $4, $5, $6, 10, NOW())
      ON CONFLICT (pedido_id) DO NOTHING
      RETURNING pedido_id;
      `,
      [
        String(pedido.id),
        repartidor.id,
        repartidor.nombre,
        pedido.nombre || "",
        pedido.zona || "",
        String(pedido.costo || ""),
      ]
    );

    if (resultado.rows.length > 0) {
      console.log("💰 Entrega registrada:", {
        pedidoId: pedido.id,
        repartidor: repartidor.nombre,
        comisionDueno: 10,
        guardadoEn: "PostgreSQL",
      });
    }
  } catch (error) {
    console.log("⚠️ Error registrando entrega en DB:", error.message);
    await registrarEntregaRepartidorLocal({
      ...pedido,
      repartidorId: repartidor.id,
      repartidorNombre: repartidor.nombre,
    });
  }
}

// 👑 Login de dueño
app.post("/dueno/login", (req, res) => {
  const usuario = String(req.body.usuario || "").trim();
  const pin = String(req.body.pin || "").trim();

  if (!validarCredencialesDueno(usuario, pin)) {
    return res.status(401).json({
      ok: false,
      mensaje: "Usuario o PIN de dueño incorrecto.",
    });
  }

  return res.json({
    ok: true,
    mensaje: "Inicio de sesión de dueño correcto.",
    dueno: {
      usuario: DUENO.usuario,
      nombre: DUENO.nombre,
    },
  });
});

// 👑 Resumen de entregas para el dueño
app.post("/dueno/estado-negocios", async (req, res) => {
  try {
    const { usuario, pin } = req.body || {};

    if (!validarCredencialesDueno(usuario, pin)) {
      return res.status(401).json({
        ok: false,
        mensaje: "Credenciales incorrectas.",
      });
    }

    const estado = await obtenerEstadoNegocios();

    return res.json({
      ok: true,
      estado,
    });
  } catch (error) {
    console.log("Error estado negocios dueño:", error);

    return res.status(500).json({
      ok: false,
      mensaje: "No se pudo cargar el estado de negocios.",
    });
  }
});

app.post("/dueno/cambiar-negocio", async (req, res) => {
  try {
    const { usuario, pin, negocioId, negocioNombre, abierto, modo } = req.body || {};

    if (!validarCredencialesDueno(usuario, pin)) {
      return res.status(401).json({
        ok: false,
        mensaje: "Credenciales incorrectas.",
      });
    }

    const resultado = await actualizarEstadoNegocio(
      negocioId,
      negocioNombre,
      Boolean(abierto),
      modo
    );

    if (!resultado.ok) {
      return res.status(400).json(resultado);
    }

    return res.json(resultado);
  } catch (error) {
    console.log("Error cambiando negocio:", error);

    return res.status(500).json({
      ok: false,
      mensaje: "No se pudo actualizar el negocio.",
    });
  }
});

app.post("/dueno/resumen-entregas", async (req, res) => {
  try {
    const usuario = String(req.body.usuario || "").trim();
    const pin = String(req.body.pin || "").trim();
    const fecha = String(req.body.fecha || obtenerFechaMexico()).trim();

    if (!validarCredencialesDueno(usuario, pin)) {
      return res.status(401).json({
        ok: false,
        mensaje: "No autorizado.",
      });
    }

    const resumen = await obtenerResumenEntregasDueno(fecha);

    return res.json({
      ok: true,
      ...resumen,
    });
  } catch (error) {
    console.log("⚠️ Error obteniendo resumen de dueño:", error.message);

    return res.status(500).json({
      ok: false,
      mensaje: "No se pudo obtener el resumen de entregas.",
    });
  }
});

// 🛵 Login de repartidor
app.post("/repartidor/login", (req, res) => {
  const usuario = String(req.body.usuario || req.body.nombre || "").trim();
  const pin = String(req.body.pin || "").trim();

  const repartidor = obtenerRepartidorPorCredenciales(usuario, pin);

  if (!repartidor) {
    return res.status(401).json({
      ok: false,
      mensaje: "Repartidor o PIN incorrecto.",
    });
  }

  return res.json({
    ok: true,
    mensaje: "Inicio de sesión correcto.",
    repartidor: {
      id: repartidor.id,
      nombre: repartidor.nombre,
    },
  });
});

// 👤 Registrar cliente con teléfono + PIN
app.post("/auth/registrar", async (req, res) => {
  try {
    if (!baseDatosLista || !pool) {
      return res.status(500).json({
        ok: false,
        mensaje: "Base de datos no disponible.",
      });
    }

    const nombre = String(req.body.nombre || "").trim();
    const telefono = limpiarTelefono(req.body.telefono);
    const pin = String(req.body.pin || "").trim();
    const clienteIdActual = String(req.body.clienteIdActual || "").trim();

    if (!nombre) {
      return res.status(400).json({
        ok: false,
        mensaje: "Escribe tu nombre.",
      });
    }

    if (telefono.length < 10) {
      return res.status(400).json({
        ok: false,
        mensaje: "Escribe un número de teléfono válido.",
      });
    }

    if (!validarPin(pin)) {
      return res.status(400).json({
        ok: false,
        mensaje: "El PIN debe tener de 4 a 6 números.",
      });
    }

    const existe = await pool.query(
      "SELECT cliente_id FROM clientes WHERE telefono = $1",
      [telefono]
    );

    if (existe.rows.length > 0) {
      return res.status(409).json({
        ok: false,
        mensaje: "Ese teléfono ya está registrado. Inicia sesión.",
      });
    }

    let clienteId = clienteIdActual || crypto.randomUUID();

// Si este clienteId ya fue usado por otra cuenta,
// creamos uno nuevo para evitar error de duplicado.
if (clienteIdActual) {
  const clienteIdExiste = await pool.query(
    "SELECT telefono FROM clientes WHERE cliente_id = $1",
    [clienteIdActual]
  );

  if (
    clienteIdExiste.rows.length > 0 &&
    clienteIdExiste.rows[0].telefono !== telefono
  ) {
    clienteId = crypto.randomUUID();
  }
}

const pinHash = await bcrypt.hash(pin, 10);

await pool.query(
  `
  INSERT INTO clientes (cliente_id, telefono, nombre, pin_hash)
  VALUES ($1, $2, $3, $4)
  `,
  [clienteId, telefono, nombre, pinHash]
);

    await pool.query(
      `
      INSERT INTO recompensas (cliente_id)
      VALUES ($1)
      ON CONFLICT (cliente_id) DO NOTHING
      `,
      [clienteId]
    );

    const recompensa = await obtenerRecompensaPublica(clienteId);

    res.json({
      ok: true,
      mensaje: "Cliente registrado correctamente.",
      cliente: {
        clienteId,
        nombre,
        telefono,
      },
      recompensa,
    });
  } catch (error) {
    console.log("⚠️ Error registrando cliente:", error.message);

    res.status(500).json({
      ok: false,
      mensaje: "No se pudo registrar el cliente.",
    });
  }
});

// 🔐 Login con teléfono + PIN
app.post("/auth/login", async (req, res) => {
  try {
    if (!baseDatosLista || !pool) {
      return res.status(500).json({
        ok: false,
        mensaje: "Base de datos no disponible.",
      });
    }

    const telefono = limpiarTelefono(req.body.telefono);
    const pin = String(req.body.pin || "").trim();

    if (telefono.length < 10 || !validarPin(pin)) {
      return res.status(400).json({
        ok: false,
        mensaje: "Teléfono o PIN inválido.",
      });
    }

    const resultado = await pool.query(
      `
      SELECT cliente_id, telefono, nombre, pin_hash
      FROM clientes
      WHERE telefono = $1
      `,
      [telefono]
    );

    if (resultado.rows.length === 0) {
      return res.status(401).json({
        ok: false,
        mensaje: "Teléfono o PIN incorrecto.",
      });
    }

    const cliente = resultado.rows[0];
    const pinCorrecto = await bcrypt.compare(pin, cliente.pin_hash);

    if (!pinCorrecto) {
      return res.status(401).json({
        ok: false,
        mensaje: "Teléfono o PIN incorrecto.",
      });
    }

    const recompensa = await obtenerRecompensaPublica(cliente.cliente_id);

    res.json({
      ok: true,
      mensaje: "Inicio de sesión correcto.",
      cliente: {
        clienteId: cliente.cliente_id,
        nombre: cliente.nombre,
        telefono: cliente.telefono,
      },
      recompensa,
    });
  } catch (error) {
    console.log("⚠️ Error iniciando sesión:", error.message);

    res.status(500).json({
      ok: false,
      mensaje: "No se pudo iniciar sesión.",
    });
  }
});
// 📦 Guardar pedido en PostgreSQL
async function guardarPedidoEnDB(pedido) {
  if (!baseDatosLista || !pool || !pedido?.id || !pedido?.clienteId) {
    return;
  }

  try {
    await pool.query(
      `
      INSERT INTO pedidos (
        id,
        cliente_id,
        estado,
        data,
        fecha_creacion,
        fecha_actualizacion
      )
      VALUES (
        $1,
        $2,
        $3,
        $4::jsonb,
        COALESCE($5::timestamptz, NOW()),
        NOW()
      )
      ON CONFLICT (id) DO UPDATE
      SET
        cliente_id = EXCLUDED.cliente_id,
        estado = EXCLUDED.estado,
        data = EXCLUDED.data,
        fecha_actualizacion = NOW();
      `,
      [
        String(pedido.id),
        pedido.clienteId,
        pedido.estado || "pendiente",
        JSON.stringify(pedido),
        pedido.fecha || null
      ]
    );
        console.log("💾 Pedido guardado en PostgreSQL:", pedido.id);
  } catch (error) {
    console.log("⚠️ No se pudo guardar pedido en PostgreSQL:", error.message);
  }
}

// 📚 Cargar pedidos guardados al iniciar el backend
async function cargarPedidosDesdeDB() {
  if (!baseDatosLista || !pool) {
    return;
  }

  try {
    const resultado = await pool.query(`
      SELECT data
      FROM pedidos
      ORDER BY fecha_creacion DESC
      LIMIT 300;
    `);

    pedidos = resultado.rows
      .map((row) => row.data)
      .filter(Boolean);

    console.log("📚 Pedidos cargados desde PostgreSQL:", pedidos.length);
  } catch (error) {
    console.log("⚠️ No se pudieron cargar pedidos desde PostgreSQL:", error.message);
  }
}

// 🍀 Configuración de promociones
const promociones = {
  fecha: null,
  ganadoresHoy: 0,

  // Configuración
  maxGanadoresAltaProbabilidad: 2,
  probabilidadAlta: 35, // %
  probabilidadBaja: 10, // %
};

// 🕒 Fecha local de México para reinicio diario
function obtenerFechaMexico() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Mexico_City",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

// 📅 Reinicia las promociones cuando cambia el día
function verificarReinicioPromociones() {
  const hoy = obtenerFechaMexico();

  if (promociones.fecha !== hoy) {
    promociones.fecha = hoy;
    promociones.ganadoresHoy = 0;

    console.log("🍀 Promociones reiniciadas:", hoy);
  }
}

// 🎲 Obtiene la probabilidad actual
function obtenerProbabilidadActual() {
  verificarReinicioPromociones();

  if (
    promociones.ganadoresHoy <
    promociones.maxGanadoresAltaProbabilidad
  ) {
    return promociones.probabilidadAlta;
  }

  return promociones.probabilidadBaja;
}

// 🕒 Convierte una fecha ISO al día de México
function obtenerFechaMexicoDesdeISO(fechaISO) {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Mexico_City",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(fechaISO));
  } catch {
    return null;
  }
}

// 🍀 Cuenta ganadores del día usando los pedidos guardados
async function sincronizarPromocionesDesdePedidos() {
  verificarReinicioPromociones();

  const hoy = obtenerFechaMexico();

  promociones.ganadoresHoy = pedidos.filter((p) => {
    return (
      p?.promocion?.ganador === true &&
      p?.promocion?.fecha &&
      obtenerFechaMexicoDesdeISO(p.promocion.fecha) === hoy
    );
  }).length;

  console.log("🍀 Ganadores cargados desde pedidos:", {
    fecha: hoy,
    ganadoresHoy: promociones.ganadoresHoy,
  });
}
// 🎁 Promoción vacía para cada pedido
function crearPromocionVacia() {
  return {
    participo: false,
    ganador: false,
    fecha: null,
    premio: null,
  };
}

function obtenerPedidosCliente(clientePedidoId) {
  const id = String(clientePedidoId || "").trim();

  if (!id) {
    return [];
  }

  return pedidos
    .filter((p) => String(p?.clienteId) === id)
    .sort((a, b) => obtenerTiempoPedido(b) - obtenerTiempoPedido(a));
}

const PEDIDO_DUPLICADO_MS = 5 * 60 * 1000;

function normalizarTextoFirmaPedido(valor) {
  return String(valor ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function crearFirmaPedidoCliente(pedido) {
  const carritoSeguro = Array.isArray(pedido?.carritoNegocios)
    ? pedido.carritoNegocios.map((item) => ({
        id: item?.id || item?.productoId || "",
        nombre: item?.nombre || "",
        cantidad: item?.cantidad || 1,
        precio: item?.precio ?? null,
        negocioId: item?.negocioId || "",
      }))
    : [];

  return [
    "cliente",
    pedido?.clienteId,
    "nombre",
    pedido?.nombre,
    "pedido",
    pedido?.pedido,
    "ubicacion",
    pedido?.ubicacion,
    "zona",
    pedido?.zona,
    "costo",
    pedido?.costo,
    "negocios",
    (pedido?.negociosIds || []).join(","),
    "carrito",
    JSON.stringify(carritoSeguro),
  ]
    .map(normalizarTextoFirmaPedido)
    .join("|")
    .slice(0, 3000);
}

function pedidoSigueActivoParaDuplicado(pedido) {
  const estado = String(pedido?.estado || "").toLowerCase();
  return estado !== "cancelado" && estado !== "entregado";
}

function buscarPedidoDuplicadoReciente(data) {
  const clientePedidoClave = String(
    data?.clientePedidoClave || data?.pedidoClienteClave || ""
  ).trim();

  const firmaPedido = clientePedidoClave || crearFirmaPedidoCliente(data);
  const clienteIdPedido = String(data?.clienteId || "").trim();

  if (!clienteIdPedido || !firmaPedido) {
    return null;
  }

  return pedidos.find((pedido) => {
    if (String(pedido?.clienteId || "") !== clienteIdPedido) {
      return false;
    }

    if (!pedidoSigueActivoParaDuplicado(pedido)) {
      return false;
    }

    const tiempoPedido = obtenerTiempoPedido(pedido);

    if (Number.isNaN(tiempoPedido) || Date.now() - tiempoPedido > PEDIDO_DUPLICADO_MS) {
      return false;
    }

    const firmaGuardada = String(
      pedido?.clientePedidoClave || pedido?.pedidoClienteClave || pedido?.firmaPedidoCliente || ""
    ).trim();

    return firmaGuardada === firmaPedido || crearFirmaPedidoCliente(pedido) === firmaPedido;
  });
}

io.on("connection", (socket) => {
  console.log("🟢 Usuario conectado:", socket.id);

  obtenerEstadoServicio()
    .then((estado) => socket.emit("servicio-actualizado", estado))
    .catch((error) => {
      console.log("⚠️ Error enviando estado de servicio:", error.message);
    });

  obtenerEstadoNegocios()
    .then((estado) => socket.emit("negocios-actualizados", estado))
    .catch((error) => {
      console.log("⚠️ Error enviando estado de negocios:", error.message);
    });

  const clienteId = socket.handshake.query.clienteId;

  // 👤 CLIENTES → room privado
  if (clienteId) {
    socket.join(clienteId);
    console.log("👤 Cliente en room:", clienteId);

    const pedidosDelCliente = obtenerPedidosCliente(clienteId);

    socket.emit(
      "pedidos-iniciales",
      pedidosDelCliente
    );

    pedidosDelCliente.forEach((pedidoCliente) => {
      emitirUltimaUbicacionRepartidorACliente(pedidoCliente);
    });

    // ⭐ Enviar estado de recompensas al cliente
    emitirRecompensaCliente(clienteId).catch((error) => {
      console.log("⚠️ Error enviando recompensa:", error.message);
    });
  }



  // 🔄 MandaPlus fix sincronización cliente v1:
  // Si el cliente vuelve a abrir la app después de estar fuera,
  // puede pedir el estado real de sus pedidos guardados en el servidor.
  socket.on("obtener-pedidos-cliente", (data, callback) => {
    const responder = (respuesta) => {
      if (typeof callback === "function") {
        callback(respuesta);
      }
    };

    const clienteConsultaId = String(data?.clienteId || clienteId || "").trim();

    if (!clienteConsultaId) {
      responder({
        ok: false,
        mensaje: "Cliente no válido.",
      });
      return;
    }

    const pedidosDelCliente = obtenerPedidosCliente(clienteConsultaId);

    socket.emit("pedidos-iniciales", pedidosDelCliente);

    pedidosDelCliente.forEach((pedidoCliente) => {
      emitirUltimaUbicacionRepartidorACliente(pedidoCliente);
    });

    responder({
      ok: true,
      pedidos: pedidosDelCliente,
    });
  });

  // ⭐ Cliente pide consultar sus recompensas
  socket.on("obtener-recompensa", async (callback) => {
    const respuesta = await obtenerRecompensaPublica(clienteId);

    socket.emit("recompensa-actualizada", respuesta);

    if (typeof callback === "function") {
      callback(respuesta);
    }
  });

  // 🟢 Consultar estado general del servicio
  socket.on("obtener-servicio", async (callback) => {
    const estado = await obtenerEstadoServicio();
    socket.emit("servicio-actualizado", estado);
    if (typeof callback === "function") callback(estado);
  });

  // 🏪 Consultar negocios abiertos/cerrados
  socket.on("obtener-negocios-estado", async (callback) => {
    const estado = await obtenerEstadoNegocios();

    socket.emit("negocios-actualizados", estado);

    if (typeof callback === "function") {
      callback(estado);
    }
  });

  // 🛵 Repartidor cambia disponible / fuera de servicio
  socket.on("repartidor-servicio", async (data, callback) => {
    const respuesta = await actualizarEstadoServicioRepartidor(
      String(data?.repartidorId || "").trim(),
      Boolean(data?.disponible)
    );

    if (typeof callback === "function") callback(respuesta);
  });

  // 🛵 REPARTIDOR → room global + historial
  socket.on("repartidor-conectar", () => {
    socket.join("repartidores");
    console.log("🛵 Repartidor conectado");

    obtenerEstadoServicio()
      .then((estado) => socket.emit("servicio-actualizado", estado))
      .catch((error) => {
        console.log("⚠️ Error enviando servicio a repartidor:", error.message);
      });

    // 🔥 HISTORIAL COMPLETO PARA REPARTIDOR
    socket.emit("pedidos-iniciales", pedidos);
  });

  // 📦 NUEVO PEDIDO
  socket.on("nuevo-pedido", async (data, callback) => {
    const responderNuevoPedido = (respuesta) => {
      if (typeof callback === "function") callback(respuesta);
    };

    const pedidoDuplicado = buscarPedidoDuplicadoReciente(data);

    if (pedidoDuplicado) {
      io.to(pedidoDuplicado.clienteId).emit("pedido-actualizado", pedidoDuplicado);
      io.to("repartidores").emit("pedido-actualizado", pedidoDuplicado);

      responderNuevoPedido({
        ok: true,
        duplicado: true,
        mensaje: "Este pedido ya estaba registrado. No se creó otro igual.",
        pedido: pedidoDuplicado,
      });

      return;
    }

    const estadoServicio = await obtenerEstadoServicio();

    if (!estadoServicio.activo) {
      const mensaje = "Por el momento estamos fuera de servicio. Intenta más tarde.";

      socket.emit("pedido-rechazado", { ok: false, mensaje });
      responderNuevoPedido({ ok: false, mensaje });

      return;
    }

    const validacionNegocios = await validarNegociosAbiertos(data?.negociosIds || []);

    if (!validacionNegocios.ok) {
      socket.emit("pedido-rechazado", {
        ok: false,
        mensaje: validacionNegocios.mensaje,
        negocioId: validacionNegocios.negocioId,
      });

      responderNuevoPedido({
        ok: false,
        mensaje: validacionNegocios.mensaje,
        negocioId: validacionNegocios.negocioId,
      });

      return;
    }

    let recompensaPedido = {
      usada: false,
      tipo: null,
    };

    const recompensaActual = await obtenerRecompensaPublica(data.clienteId);

    // ⭐ Si el cliente ya tiene recompensa disponible, se marca automáticamente
    // como cupón de $20 para el envío en el siguiente pedido.
    // No modificamos el costo automáticamente porque el envío se cobra en persona.
    const debeUsarRecompensa =
      data.recompensa?.usar === true ||
      recompensaActual?.recompensaDisponible === true;

    if (debeUsarRecompensa) {
      const resultadoRecompensa = await usarRecompensaCliente(data.clienteId);

      if (resultadoRecompensa.ok) {
        recompensaPedido = {
          usada: true,
          tipo: "cupon-20-envio-10-pedidos",
          monto: 20,
          mensaje: "CUPÓN DE $20 PARA ENVÍO",
        };
      }
    }

    const telefonoCliente = await obtenerTelefonoCliente(data.clienteId);
    const clientePedidoClave = String(
      data?.clientePedidoClave || data?.pedidoClienteClave || ""
    ).trim();
    const firmaPedidoCliente = clientePedidoClave || crearFirmaPedidoCliente(data);

    const pedidoTextoConRecompensa = recompensaPedido.usada
      ? `${data.pedido}\n\n🎁 Cupón de recompensa: -$20 en el envío.`
      : data.pedido;

    const pedido = {
      ...data,
      id: data.id || Date.now(),
      pedido: pedidoTextoConRecompensa,
      estado: "pendiente",
      costo: data.costo,
      telefonoCliente: telefonoCliente || data.telefonoCliente || "",
      clientePedidoClave: clientePedidoClave || firmaPedidoCliente,
      firmaPedidoCliente,
      promocion: crearPromocionVacia(),
      recompensa: recompensaPedido,
    };

    pedidos = [
      pedido,
      ...pedidos.filter((p) => String(p.id) !== String(pedido.id)),
    ].slice(0, 300);

    await guardarPedidoEnDB(pedido);

    // 👤 SOLO cliente dueño
    io.to(pedido.clienteId).emit("pedido-actualizado", pedido);

    // 🛵 TODOS los repartidores
    io.to("repartidores").emit("nuevo-pedido-repartidor", pedido);

    console.log("📦 Pedido creado:", pedido.id);

    responderNuevoPedido({
      ok: true,
      pedido,
    });
  });

  // 🔄 CAMBIAR ESTADO
  socket.on("cambiar-estado", async (pedidoActualizado, callback) => {
    const responderCambioEstado = (respuesta) => {
      if (typeof callback === "function") {
        callback(respuesta);
      }
    };

    const enviarErrorEstado = (pedidoBase, mensaje) => {
      socket.emit("error-repartidor", {
        pedidoId: pedidoActualizado?.id,
        mensaje,
      });

      if (pedidoBase) {
        socket.emit("pedido-actualizado", pedidoBase);
      }

      responderCambioEstado({
        ok: false,
        mensaje,
        pedido: pedidoBase || null,
      });
    };

    const pedidoAnterior = pedidos.find(
      (p) => String(p.id) === String(pedidoActualizado.id)
    );

    if (!pedidoAnterior) {
      enviarErrorEstado(null, "Pedido no encontrado.");
      return;
    }

    const repartidorActivo = obtenerRepartidorPorId(pedidoActualizado.repartidorId);

    if (!repartidorActivo) {
      enviarErrorEstado(pedidoAnterior, "Inicia sesión como repartidor válido.");
      return;
    }

    const estadoAnterior = String(pedidoAnterior.estado || "").toLowerCase();
    const estadoSolicitado = String(pedidoActualizado.estado || "").toLowerCase();

    const pedidoFinalizado =
      estadoAnterior === "cancelado" || estadoAnterior === "entregado";

    if (pedidoFinalizado && estadoSolicitado !== estadoAnterior) {
      enviarErrorEstado(pedidoAnterior, "Este pedido ya está finalizado.");
      return;
    }

    const pedidoYaTieneRepartidor = Boolean(pedidoAnterior.repartidorId);
    const pedidoEsDeOtroRepartidor =
      pedidoYaTieneRepartidor &&
      String(pedidoAnterior.repartidorId) !== String(repartidorActivo.id);

    if (
      estadoSolicitado === "aceptado" &&
      !(await repartidorPuedeAceptarPedido(repartidorActivo.id, pedidoAnterior))
    ) {
      enviarErrorEstado(
        pedidoAnterior,
        "Estás fuera de servicio. Solo puedes aceptar pedidos que llegaron antes de que terminaras tu jornada."
      );
      return;
    }

    if (estadoSolicitado === "aceptado" && pedidoEsDeOtroRepartidor) {
      enviarErrorEstado(
        pedidoAnterior,
        `Este pedido ya fue aceptado por ${pedidoAnterior.repartidorNombre || "otro repartidor"}.`
      );
      return;
    }

    if (
      ["en camino", "entregado"].includes(estadoSolicitado) &&
      !pedidoYaTieneRepartidor
    ) {
      enviarErrorEstado(pedidoAnterior, "Primero debes aceptar el pedido.");
      return;
    }

    if (
      ["en camino", "entregado"].includes(estadoSolicitado) &&
      pedidoEsDeOtroRepartidor
    ) {
      enviarErrorEstado(
        pedidoAnterior,
        `Solo ${pedidoAnterior.repartidorNombre || "el repartidor asignado"} puede actualizar este pedido.`
      );
      return;
    }

    const repartidorAsignadoId =
      pedidoAnterior.repartidorId || repartidorActivo.id;

    const repartidorAsignadoNombre =
      pedidoAnterior.repartidorNombre || repartidorActivo.nombre;

    const actualizado = {
      ...(pedidoAnterior || {}),
      ...pedidoActualizado,
      estado: pedidoActualizado.estado,
      repartidorId: repartidorAsignadoId,
      repartidorNombre: repartidorAsignadoNombre,
      fechaActualizacionEstado: new Date().toISOString(),
    };

    const existePedido = pedidos.some(
      (p) => String(p.id) === String(actualizado.id)
    );

    pedidos = existePedido
      ? pedidos.map((p) =>
          String(p.id) === String(actualizado.id) ? actualizado : p
        )
      : [actualizado, ...pedidos];

    pedidos = pedidos.slice(0, 300);

    await guardarPedidoEnDB(actualizado);

    io.to(actualizado.clienteId).emit(
      "pedido-actualizado",
      actualizado
    );

    io.to("repartidores").emit(
      "pedido-actualizado",
      actualizado
    );

    emitirUltimaUbicacionRepartidorACliente(actualizado);

    // ⭐ Sumar recompensa cuando el pedido se marca como entregado
    await registrarPedidoEntregado(actualizado);

    // 💰 Registrar comisión del dueño cuando el repartidor marca entregado
    await registrarEntregaRepartidor(actualizado);

    responderCambioEstado({
      ok: true,
      pedido: actualizado,
    });
  });

  // 📍 MandaPlus fix GPS cliente v1:
  // Permite que el cliente agregue GPS después de enviar el pedido.
  // Importante: solo actualiza gps/ubicacionGPS; no cambia estado ni repartidor asignado.
  socket.on("actualizar-gps-cliente", async (data, callback) => {
    const responder = (respuesta) => {
      if (typeof callback === "function") {
        callback(respuesta);
      }
    };

    const pedidoId = String(data?.pedidoId || "").trim();
    const clientePedidoId = String(data?.clienteId || clienteId || "").trim();
    const lat = Number(data?.gps?.lat ?? data?.ubicacionGPS?.lat);
    const lng = Number(data?.gps?.lng ?? data?.ubicacionGPS?.lng);

    if (!pedidoId || !clientePedidoId || !Number.isFinite(lat) || !Number.isFinite(lng)) {
      responder({
        ok: false,
        mensaje: "Datos de GPS inválidos.",
      });
      return;
    }

    const pedidoAnterior = pedidos.find(
      (p) =>
        String(p.id) === pedidoId &&
        String(p.clienteId) === clientePedidoId
    );

    if (!pedidoAnterior) {
      responder({
        ok: false,
        mensaje: "Pedido no encontrado para actualizar GPS.",
      });
      return;
    }

    const estadoPedido = String(pedidoAnterior.estado || "").toLowerCase();

    if (estadoPedido === "cancelado" || estadoPedido === "entregado") {
      responder({
        ok: false,
        mensaje: "Este pedido ya finalizó y no puede actualizar GPS.",
      });
      return;
    }

    const gpsCliente = {
      lat,
      lng,
      fechaActualizacion: new Date().toISOString(),
    };

    const actualizado = {
      ...pedidoAnterior,
      gps: gpsCliente,
      ubicacionGPS: gpsCliente,
    };

    pedidos = pedidos.map((p) =>
      String(p.id) === pedidoId ? actualizado : p
    );

    await guardarPedidoEnDB(actualizado);

    io.to(actualizado.clienteId).emit("pedido-actualizado", actualizado);
    io.to("repartidores").emit("pedido-actualizado", actualizado);

    responder({
      ok: true,
      pedido: actualizado,
    });

    console.log("📍 GPS del cliente actualizado:", {
      pedidoId: actualizado.id,
      clienteId: actualizado.clienteId,
      estado: actualizado.estado,
      repartidorId: actualizado.repartidorId || "",
    });
  });

  // ❌ CANCELAR
  socket.on("cancelar-pedido", async (data, callback) => {
    const responderCancelacion = (respuesta) => {
      if (typeof callback === "function") {
        callback(respuesta);
      }
    };

    const pedidoId = String(data?.id || "").trim();

    const pedidoAnterior = pedidos.find(
      (p) => String(p.id) === pedidoId
    );

    if (!pedidoAnterior) {
      responderCancelacion({
        ok: false,
        mensaje: "Pedido no encontrado.",
      });
      return;
    }

    const estadoAnterior = String(pedidoAnterior.estado || "").toLowerCase();

    if (estadoAnterior === "entregado") {
      responderCancelacion({
        ok: false,
        mensaje: "Este pedido ya está entregado y no se puede cancelar.",
        pedido: pedidoAnterior,
      });
      return;
    }

    if (estadoAnterior === "cancelado") {
      responderCancelacion({
        ok: true,
        mensaje: "Este pedido ya estaba cancelado.",
        pedido: pedidoAnterior,
      });
      return;
    }

    const repartidorId = String(data?.repartidorId || "").trim();
    let repartidorCancelacion = null;

    if (repartidorId) {
      repartidorCancelacion = obtenerRepartidorPorId(repartidorId);

      if (!repartidorCancelacion) {
        responderCancelacion({
          ok: false,
          mensaje: "Repartidor no válido para cancelar.",
          pedido: pedidoAnterior,
        });
        return;
      }

      if (
        pedidoAnterior.repartidorId &&
        String(pedidoAnterior.repartidorId) !== String(repartidorCancelacion.id)
      ) {
        responderCancelacion({
          ok: false,
          mensaje: `Solo ${pedidoAnterior.repartidorNombre || "el repartidor asignado"} puede cancelar este pedido.`,
          pedido: pedidoAnterior,
        });
        return;
      }
    }

    const actualizado = {
      ...pedidoAnterior,
      estado: "cancelado",
      canceladoPor: repartidorCancelacion ? "repartidor" : "cliente",
      canceladoPorId: repartidorCancelacion?.id || pedidoAnterior.clienteId || "",
      canceladoPorNombre:
        repartidorCancelacion?.nombre ||
        data?.canceladoPorNombre ||
        pedidoAnterior.nombre ||
        "",
      fechaCancelacion: new Date().toISOString(),
    };

    pedidos = pedidos.map((p) =>
      String(p.id) === pedidoId ? actualizado : p
    );

    await guardarPedidoEnDB(actualizado);

    io.to(actualizado.clienteId).emit(
      "pedido-actualizado",
      actualizado
    );

    io.to("repartidores").emit(
      "pedido-actualizado",
      actualizado
    );

    responderCancelacion({
      ok: true,
      pedido: actualizado,
    });
  });

  // 🍀 PROBAR SUERTE
  socket.on("probar-suerte", async ({ pedidoId }, callback) => {
    await sincronizarPromocionesDesdePedidos();

    const responder = (respuesta) => {
      socket.emit("resultado-promocion", respuesta);

      if (typeof callback === "function") {
        callback(respuesta);
      }
    };

    const pedido = pedidos.find(
      (p) => String(p.id) === String(pedidoId)
    );

    // El pedido no existe
    if (!pedido) {
      responder({
        ok: false,
        mensaje: "Pedido no encontrado.",
      });
      return;
    }

    // Protección por si algún pedido viejo no tiene promoción
    if (!pedido.promocion) {
      pedido.promocion = crearPromocionVacia();
    }

    // Ya participó anteriormente
    if (pedido.promocion.participo) {
      responder({
        ok: false,
        mensaje: "Ya utilizaste tu oportunidad en este pedido.",
      });
      return;
    }

    // No permitir pedidos cancelados
    if (String(pedido.estado || "").toLowerCase() === "cancelado") {
      responder({
        ok: false,
        mensaje: "Los pedidos cancelados no participan.",
      });
      return;
    }

    // Solo permitir participar cuando el pedido ya fue entregado.
    // Esto evita que el cliente cancele e intente varias veces hasta ganar.
    if (String(pedido.estado || "").toLowerCase() !== "entregado") {
      responder({
        ok: false,
        mensaje: "Podrás probar tu suerte cuando el repartidor marque tu pedido como entregado. Si ganas, no se cobra el envío.",
      });
      return;
    }

    const probabilidad = obtenerProbabilidadActual();
    const numero = Math.random() * 100;
    const ganador = numero < probabilidad;

    pedido.promocion.participo = true;
    pedido.promocion.ganador = ganador;
    pedido.promocion.fecha = new Date().toISOString();

    if (ganador) {
      promociones.ganadoresHoy++;
      pedido.promocion.premio = "Envío Gratis";
    }

    await guardarPedidoEnDB(pedido);

    // Avisar al cliente
    io.to(pedido.clienteId).emit("pedido-actualizado", pedido);

    // Avisar al repartidor
    io.to("repartidores").emit("pedido-actualizado", pedido);

    const resultado = {
      ok: true,
      ganador,
      probabilidad,
      ganadoresHoy: promociones.ganadoresHoy,
    };

    // Resultado inmediato para quien presionó el botón
    responder(resultado);

    console.log("🍀 Sorteo realizado:", {
      pedidoId: pedido.id,
      ganador,
      probabilidad,
      ganadoresHoy: promociones.ganadoresHoy,
    });
  });

  // 🛵 GPS repartidor
  socket.on("repartidor-ubicacion", (data) => {
    const repartidorActivo = obtenerRepartidorPorId(data?.repartidorId);

    if (!repartidorActivo) {
      return;
    }

    const gpsRepartidor = guardarUltimaUbicacionRepartidor(
      data,
      repartidorActivo
    );

    if (!gpsRepartidor) {
      return;
    }

    const clientesConPedidoAsignado = [
      ...new Set(
        pedidos
          .filter((p) => {
            const estado = String(p.estado || "").toLowerCase();

            return (
              String(p.repartidorId || "") === String(repartidorActivo.id) &&
              estado !== "cancelado" &&
              estado !== "entregado" &&
              p.clienteId
            );
          })
          .map((p) => String(p.clienteId))
      ),
    ];

    clientesConPedidoAsignado.forEach((idCliente) => {
      io.to(idCliente).emit("repartidor-movimiento", gpsRepartidor);
    });
  });

  socket.on("disconnect", () => {
    console.log("🔴 Usuario desconectado:", socket.id);
  });
});

const PORT = process.env.PORT || 3001;

async function iniciarServidor() {
  await inicializarBaseDatos();
  await cargarPedidosDesdeDB();
  await sincronizarPromocionesDesdePedidos();

  server.listen(PORT, () => {
    console.log("🚀 Servidor Socket.io corriendo en puerto " + PORT);
  });
}

iniciarServidor();


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

    const clienteId = clienteIdActual || crypto.randomUUID();
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

// 🎁 Promoción vacía para cada pedido
function crearPromocionVacia() {
  return {
    participo: false,
    ganador: false,
    fecha: null,
    premio: null,
  };
}

io.on("connection", (socket) => {
  console.log("🟢 Usuario conectado:", socket.id);

  const clienteId = socket.handshake.query.clienteId;

  // 👤 CLIENTES → room privado
  if (clienteId) {
    socket.join(clienteId);
    console.log("👤 Cliente en room:", clienteId);

    socket.emit(
      "pedidos-iniciales",
      pedidos.filter((p) => p.clienteId === clienteId)
    );

    // ⭐ Enviar estado de recompensas al cliente
    emitirRecompensaCliente(clienteId).catch((error) => {
      console.log("⚠️ Error enviando recompensa:", error.message);
    });
  }

  // ⭐ Cliente pide consultar sus recompensas
  socket.on("obtener-recompensa", async (callback) => {
    const respuesta = await obtenerRecompensaPublica(clienteId);

    socket.emit("recompensa-actualizada", respuesta);

    if (typeof callback === "function") {
      callback(respuesta);
    }
  });

  // 🛵 REPARTIDOR → room global + historial
  socket.on("repartidor-conectar", () => {
    socket.join("repartidores");
    console.log("🛵 Repartidor conectado");

    // 🔥 HISTORIAL COMPLETO PARA REPARTIDOR
    socket.emit("pedidos-iniciales", pedidos);
  });

  // 📦 NUEVO PEDIDO
  socket.on("nuevo-pedido", async (data) => {
    let recompensaPedido = {
      usada: false,
      tipo: null,
    };

    // ⭐ El cliente puede mandar data.recompensa.usar = true
    // para aplicar su envío gratis.
    if (data.recompensa?.usar === true) {
      const resultadoRecompensa = await usarRecompensaCliente(data.clienteId);

      if (resultadoRecompensa.ok) {
        recompensaPedido = {
          usada: true,
          tipo: "envio-gratis-10-pedidos",
          mensaje: "ENVÍO GRATIS POR RECOMPENSA",
        };
      }
    }

    const pedido = {
      ...data,
      id: data.id || Date.now(),
      estado: "pendiente",
      promocion: crearPromocionVacia(),
      recompensa: recompensaPedido,
    };

    pedidos.push(pedido);

    // 👤 SOLO cliente dueño
    io.to(pedido.clienteId).emit("pedido-actualizado", pedido);

    // 🛵 TODOS los repartidores
    io.to("repartidores").emit("nuevo-pedido-repartidor", pedido);

    console.log("📦 Pedido creado:", pedido.id);
  });

  // 🔄 CAMBIAR ESTADO
  socket.on("cambiar-estado", async (pedidoActualizado) => {
    const pedidoAnterior = pedidos.find((p) => p.id === pedidoActualizado.id);

    const actualizado = {
      ...(pedidoAnterior || {}),
      ...pedidoActualizado,
    };

    pedidos = pedidos.map((p) =>
      p.id === actualizado.id ? actualizado : p
    );

    io.to(actualizado.clienteId).emit(
      "pedido-actualizado",
      actualizado
    );

    io.to("repartidores").emit(
      "pedido-actualizado",
      actualizado
    );

    // ⭐ Sumar recompensa cuando el pedido se marca como entregado
    await registrarPedidoEntregado(actualizado);
  });

  // ❌ CANCELAR
  socket.on("cancelar-pedido", (data) => {
    pedidos = pedidos.map((p) =>
      p.id === data.id ? { ...p, estado: "cancelado" } : p
    );

    const actualizado = pedidos.find((p) => p.id === data.id);

    if (actualizado) {
      io.to(actualizado.clienteId).emit(
        "pedido-actualizado",
        actualizado
      );

      io.to("repartidores").emit(
        "pedido-actualizado",
        actualizado
      );
    }
  });

  // 🍀 PROBAR SUERTE
  socket.on("probar-suerte", ({ pedidoId }, callback) => {
    verificarReinicioPromociones();

    const responder = (respuesta) => {
      socket.emit("resultado-promocion", respuesta);

      if (typeof callback === "function") {
        callback(respuesta);
      }
    };

    const pedido = pedidos.find((p) => p.id === pedidoId);

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
    if (pedido.estado === "cancelado") {
      responder({
        ok: false,
        mensaje: "Los pedidos cancelados no participan.",
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
      pedido.promocion.premio = "Pedido Gratis";
    }

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
    io.emit("repartidor-movimiento", data);
  });

  socket.on("disconnect", () => {
    console.log("🔴 Usuario desconectado:", socket.id);
  });
});

const PORT = process.env.PORT || 3001;

async function iniciarServidor() {
  await inicializarBaseDatos();

  server.listen(PORT, () => {
    console.log("🚀 Servidor Socket.io corriendo en puerto " + PORT);
  });
}

iniciarServidor();
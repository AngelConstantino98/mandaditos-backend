const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors());

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
  },
});

// 🧠 Memoria de pedidos
let pedidos = [];

// ⭐ Archivo simple para guardar recompensas
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

function crearRecompensaVacia() {
  return {
    pedidosCompletados: 0,
    meta: 10,
    recompensaDisponible: false,
    pedidosContados: [],
    fechaActualizacion: null,
  };
}

function obtenerRecompensaCliente(clienteId) {
  if (!clienteId) return null;

  if (!recompensas[clienteId]) {
    recompensas[clienteId] = crearRecompensaVacia();
    guardarRecompensas();
  }

  return recompensas[clienteId];
}

function obtenerRecompensaPublica(clienteId) {
  const recompensa = obtenerRecompensaCliente(clienteId);

  if (!recompensa) return null;

  return {
    clienteId,
    pedidosCompletados: recompensa.pedidosCompletados,
    meta: recompensa.meta,
    recompensaDisponible: recompensa.recompensaDisponible,
    faltan: Math.max(recompensa.meta - recompensa.pedidosCompletados, 0),
  };
}

function emitirRecompensaCliente(clienteId) {
  if (!clienteId) return;

  io.to(clienteId).emit(
    "recompensa-actualizada",
    obtenerRecompensaPublica(clienteId)
  );
}

function registrarPedidoEntregado(pedido) {
  if (!pedido?.clienteId || pedido.estado !== "entregado") return;

  const recompensa = obtenerRecompensaCliente(pedido.clienteId);
  const pedidoId = String(pedido.id);

  // Evita sumar el mismo pedido dos veces
  if (recompensa.pedidosContados.includes(pedidoId)) {
    emitirRecompensaCliente(pedido.clienteId);
    return;
  }

  // Si ya tiene recompensa disponible, dejamos el progreso en 10/10
  // hasta que el cliente use su envío gratis.
  if (recompensa.recompensaDisponible) {
    emitirRecompensaCliente(pedido.clienteId);
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

  emitirRecompensaCliente(pedido.clienteId);

  console.log("⭐ Recompensa actualizada:", {
    clienteId: pedido.clienteId,
    pedidosCompletados: recompensa.pedidosCompletados,
    recompensaDisponible: recompensa.recompensaDisponible,
  });
}

function usarRecompensaCliente(clienteId) {
  const recompensa = obtenerRecompensaCliente(clienteId);

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
  emitirRecompensaCliente(clienteId);

  return {
    ok: true,
    mensaje: "Recompensa usada correctamente.",
  };
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
    emitirRecompensaCliente(clienteId);
  }

  // ⭐ Cliente pide consultar sus recompensas
  socket.on("obtener-recompensa", (callback) => {
    const respuesta = obtenerRecompensaPublica(clienteId);

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
  socket.on("nuevo-pedido", (data) => {
    let recompensaPedido = {
      usada: false,
      tipo: null,
    };

    // ⭐ En pasos siguientes el cliente podrá mandar data.recompensa.usar = true
    // para aplicar su envío gratis.
    if (data.recompensa?.usar === true) {
      const resultadoRecompensa = usarRecompensaCliente(data.clienteId);

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
  socket.on("cambiar-estado", (pedidoActualizado) => {
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
    registrarPedidoEntregado(actualizado);
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

server.listen(PORT, () => {
  console.log("🚀 Servidor Socket.io corriendo en puerto " + PORT);
});
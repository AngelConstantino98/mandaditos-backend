const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors());

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
  },
});

// 🧠 memoria de pedidos
let pedidos = [];

io.on("connection", (socket) => {
  console.log("🟢 Usuario conectado:", socket.id);

  const clienteId = socket.handshake.query.clienteId;

  // 🔐 meter cada cliente en su propia sala
  if (clienteId) {
    socket.join(clienteId);
    console.log("📦 Cliente en room:", clienteId);
  }

  // 📦 SOLO enviar historial del cliente
  socket.emit(
    "pedidos-iniciales",
    pedidos.filter((p) => p.clienteId === clienteId)
  );

  // 📦 NUEVO PEDIDO
  socket.on("nuevo-pedido", (data) => {
    const pedido = {
      ...data,
      id: Date.now(),
      estado: "pendiente",
    };

    pedidos.push(pedido);

    // 🔥 SOLO a su room
    io.to(pedido.clienteId).emit("pedido-actualizado", pedido);
  });

  // 🔄 CAMBIAR ESTADO
  socket.on("cambiar-estado", (pedidoActualizado) => {
    pedidos = pedidos.map((p) =>
      p.id === pedidoActualizado.id ? pedidoActualizado : p
    );

    io.to(pedidoActualizado.clienteId).emit(
      "pedido-actualizado",
      pedidoActualizado
    );
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
    }
  });

  // 🛵 GPS repartidor (esto sí es global)
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
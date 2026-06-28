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

  // 📦 NUEVO PEDIDO
  socket.on("nuevo-pedido", (data) => {
    const pedido = {
      ...data,
      id: Date.now(),
      estado: "pendiente"
    };

    pedidos.push(pedido);

    io.emit("pedido-nuevo", pedido);
  });

  // 🔄 CAMBIAR ESTADO DEL PEDIDO
  socket.on("cambiar-estado", (pedidoActualizado) => {
    pedidos = pedidos.map((p) =>
      p.id === pedidoActualizado.id ? pedidoActualizado : p
    );

    io.emit("pedido-actualizado", pedidoActualizado);
  });

  // 🛵 GPS REPARTIDOR
  socket.on("repartidor-ubicacion", (data) => {
    io.emit("repartidor-movimiento", data);
  });

  // 📦 ENVIAR PEDIDOS EXISTENTES AL CONECTARSE
  socket.emit("pedidos-iniciales", pedidos);

  socket.on("disconnect", () => {
    console.log("🔴 Usuario desconectado:", socket.id);
  });
});

const PORT = process.env.PORT || 3001;

server.listen(PORT, () => {
  console.log("🚀 Servidor Socket.io corriendo en puerto " + PORT);
});
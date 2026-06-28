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

// 📡 cuando alguien se conecta
io.on("connection", (socket) => {
  console.log("🟢 Usuario conectado:", socket.id);

  // 📦 NUEVO PEDIDO
  socket.on("nuevo-pedido", (data) => {
    console.log("📦 Pedido recibido:", data);

    // reenviar a todos los clientes (repartidores y admin)
    io.emit("pedido-actualizado", data);
  });

  // 🛵 UBICACIÓN DEL REPARTIDOR EN VIVO
  socket.on("repartidor-ubicacion", (data) => {
    console.log("🛵 Ubicación repartidor:", data);

    // reenviar a todos los clientes
    io.emit("repartidor-movimiento", data);
  });

  socket.on("disconnect", () => {
    console.log("🔴 Usuario desconectado:", socket.id);
  });
});

server.listen(3001, () => {
  console.log("🚀 Servidor Socket.io corriendo en puerto 3001");
});
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

    // reenviar a todos
    io.emit("pedido-actualizado", data);
  });

  // 🛵 UBICACIÓN DEL REPARTIDOR EN VIVO
  socket.on("repartidor-ubicacion", (data) => {
    console.log("🛵 Ubicación repartidor:", data);

    // reenviar a todos
    io.emit("repartidor-movimiento", data);
  });

  socket.on("disconnect", () => {
    console.log("🔴 Usuario desconectado:", socket.id);
  });
});

// 🚀 PUERTO PARA RENDER / PRODUCCIÓN
const PORT = process.env.PORT || 3001;

server.listen(PORT, () => {
  console.log("🚀 Servidor Socket.io corriendo en puerto " + PORT);
});
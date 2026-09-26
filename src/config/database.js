const mongoose = require("mongoose");

let isConnected = false;

async function connectDB() {
  if (isConnected) return;

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error("MONGODB_URI is not set in your .env file");
  }

  await mongoose.connect(uri, {
    dbName: "airhubtool", 
  });

  isConnected = true;
  console.log("✅ MongoDB connected:", mongoose.connection.host);

  mongoose.connection.on("error", (err) => {
    console.error("MongoDB error:", err);
  });

  mongoose.connection.on("disconnected", () => {
    console.warn("MongoDB disconnected — reconnecting...");
    isConnected = false;
  });
}

module.exports = connectDB;

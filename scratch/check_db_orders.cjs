const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

async function run() {
  await mongoose.connect(process.env.MONGODB_URL);
  const db = mongoose.connection.db;
  const orders = await db.collection('shiprocketorders').find({ platform: 'shipmaxx' }).toArray();
  console.log(`ShipMaxx orders in DB: ${orders.length}`);
  orders.forEach(o => console.log(`  order_id: ${o.order_id} | status: ${o.status} | awb: ${o.awb_code || '(none)'}`));
  await mongoose.disconnect();
}

run().catch(console.error);

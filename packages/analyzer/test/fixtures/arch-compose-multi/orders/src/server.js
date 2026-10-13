const express = require('express');
const { producer } = require('./kafka');

const app = express();
app.use(express.json());

app.post('/orders', async (req, res) => {
  const stock = await fetch(`${process.env.INVENTORY_URL}/stock/${req.body.sku}`);
  await producer.send({ topic: 'order-created', messages: [{ value: JSON.stringify(req.body) }] });
  res.status(201).json(await stock.json());
});

app.listen(3000);

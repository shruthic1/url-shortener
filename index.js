import express from 'express';

const app = express();
const PORT = 3000;

app.get('/', (req, res) => {
  res.send('Hello from my URL shortener!');
});

app.listen(PORT, () => {
  console.log(`Listening at http://localhost:${PORT}`);
});
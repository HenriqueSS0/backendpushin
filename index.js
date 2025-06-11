const express = require('express');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3000;
const API_TOKEN = '33108|m5F54MDdH4l8W7Wj2vCuuA0hDN7IU7yvhF6mzwzU5ad0138a';

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const usersFilePath = path.join(__dirname, 'users.json');
const pagamentosPath = path.join(__dirname, 'pagamentos.json');
const webhooksLogPath = path.join(__dirname, 'webhooks.log');

if (!fs.existsSync(usersFilePath)) fs.writeFileSync(usersFilePath, '[]');
if (!fs.existsSync(pagamentosPath)) fs.writeFileSync(pagamentosPath, '[]');

function readUsersFromFile() {
  try { return JSON.parse(fs.readFileSync(usersFilePath, 'utf8')); } 
  catch { return []; }
}

function saveUsersToFile(users) {
  fs.writeFileSync(usersFilePath, JSON.stringify(users, null, 2));
}

function readPagamentosFromFile() {
  try { return JSON.parse(fs.readFileSync(pagamentosPath, 'utf8')); } 
  catch { return []; }
}

function savePagamentosToFile(pagamentos) {
  fs.writeFileSync(pagamentosPath, JSON.stringify(pagamentos, null, 2));
}

function logWebhook(data) {
  const logEntry = `${new Date().toISOString()} - ${JSON.stringify(data)}\n`;
  fs.appendFileSync(webhooksLogPath, logEntry, 'utf8');
}

app.post('/register', (req, res) => {
  const { username, password } = req.body;
  const users = readUsersFromFile();
  if (users.find(u => u.username === username)) return res.status(400).json({ message: 'Usuário já existe' });
  users.push({ username, password });
  saveUsersToFile(users);
  res.status(201).json({ message: 'Usuário registrado com sucesso!' });
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  const users = readUsersFromFile();
  const user = users.find(u => u.username === username && u.password === password);
  if (!user) return res.status(401).json({ success: false, message: 'Credenciais inválidas' });
  const { password: _, ...userWithoutPassword } = user;
  res.status(200).json({ success: true, message: 'Login bem-sucedido!', user: userWithoutPassword });
});

app.post('/logout', (req, res) => {
  const { username } = req.body;
  const users = readUsersFromFile();
  const index = users.findIndex(u => u.username === username);
  if (index !== -1) {
    users[index].loggedIn = false;
    saveUsersToFile(users);
    return res.json({ message: 'Logout realizado com sucesso' });
  }
  res.status(404).json({ message: 'Usuário não encontrado' });
});

app.post('/criar-pagamento', async (req, res) => {
  const { valor, descricao, entregavelUrl, cliente, produto, orderBumps } = req.body;

  if (!valor || isNaN(valor)) return res.status(400).json({ error: 'Valor inválido ou não informado' });

  try {
    const response = await axios.post('https://api.pushinpay.com.br/api/pix/cashIn', {
      value: parseFloat(valor),
      description: descricao || `Pagamento - ${produto || 'Produto não especificado'}`,
      callbackUrl: 'https://backendapi-4-r751.onrender.com/webhook/pix'
    }, {
      headers: {
        'Authorization': `Bearer ${API_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });

    const data = response.data;
    const pagamentos = readPagamentosFromFile();

    const novoPagamento = {
      id: data.transactionId,
      transactionId: data.transactionId,
      amount: parseFloat(valor),
      status: 'PENDING',
      qrCodeUrl: data.qrCodeImage,
      qrCodeText: data.qrCodeText,
      entregavelUrl,
      cliente,
      produto,
      orderBumps,
      dataCriacao: new Date().toISOString()
    };

    pagamentos.push(novoPagamento);
    savePagamentosToFile(pagamentos);

    res.json({
      success: true,
      qrCodeUrl: data.qrCodeImage,
      qrCodeText: data.qrCodeText,
      payload: data.qrCodeText,
      transactionId: data.transactionId,
      id: data.transactionId
    });

  } catch (error) {
    console.error('Erro ao criar pagamento:', error.response?.data || error.message);
    res.status(500).json({
      success: false,
      error: 'Erro ao criar pagamento',
      detalhes: error.response?.data || error.message
    });
  }
});

app.post('/webhook/pix', (req, res) => {
  logWebhook(req.body);

  const { transactionId, status, value } = req.body;

  if (!transactionId) return res.sendStatus(400);

  const pagamentos = readPagamentosFromFile();
  const index = pagamentos.findIndex(p => p.transactionId === transactionId);

  if (status === 'PAID') {
    if (index !== -1) {
      pagamentos[index].status = 'COMPLETED';
      pagamentos[index].dataConfirmacao = new Date().toISOString();
      savePagamentosToFile(pagamentos);
      console.log(`✅ Pagamento ${transactionId} confirmado!`);
    } else {
      pagamentos.push({
        id: transactionId,
        transactionId,
        amount: value || 0,
        status: 'COMPLETED',
        dataConfirmacao: new Date().toISOString(),
        notFound: true
      });
      savePagamentosToFile(pagamentos);
      console.log(`⚠️ Pagamento ${transactionId} confirmado, mas não estava no sistema!`);
    }
  }
  res.sendStatus(200);
});

app.get('/pagamentos', (req, res) => {
  res.json(readPagamentosFromFile());
});

app.get('/webhooks-log', (req, res) => {
  try {
    const logs = fs.readFileSync(webhooksLogPath, 'utf8');
    res.type('text').send(logs);
  } catch {
    res.status(404).json({ error: 'Log não encontrado' });
  }
});

app.get('/verificar-status', (req, res) => {
  const { transactionId } = req.query;
  if (!transactionId) return res.status(400).json({ success: false, error: 'Transaction ID não fornecido' });

  const pagamentos = readPagamentosFromFile();
  const pagamento = pagamentos.find(p => p.transactionId === transactionId);

  if (!pagamento) return res.status(404).json({ success: false, status: 'NOT_FOUND', message: 'Pagamento não encontrado' });

  res.json({
    success: true,
    status: pagamento.status,
    transactionId: pagamento.transactionId,
    amount: pagamento.amount,
    ...(pagamento.status === 'COMPLETED' && {
      urlEntregavel: pagamento.entregavelUrl,
      dataConfirmacao: pagamento.dataConfirmacao
    }),
    dataCriacao: pagamento.dataCriacao
  });
});

app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});

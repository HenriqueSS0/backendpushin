const express = require('express');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3000;
const PUSHINPAY_API_KEY = '253e4917e0af56f093b2d5c26349cd7c:eba256e2e9b6b0d3578c20c38fe89e43c8d860bb7c4f92b0090714f0152dc2eaaf417a10ac4ac0242a08bed6c202cd15574e11779902:362c22215b3a3f52935c498c6e71b4ee';
const PUSHINPAY_BASE_URL = 'https://api.pushinpay.com/v1';
const WEBHOOK_URL = 'https://backendpushin.onrender.com/webhook/pix'; // URL atualizada para seu servidor no Render

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const usersFilePath = path.join(__dirname, 'users.json');
const pagamentosPath = path.join(__dirname, 'pagamentos.json');
const webhooksLogPath = path.join(__dirname, 'webhooks.log');

// Garante que os arquivos existam ao iniciar
if (!fs.existsSync(usersFilePath)) {
  fs.writeFileSync(usersFilePath, '[]');
}
if (!fs.existsSync(pagamentosPath)) {
  fs.writeFileSync(pagamentosPath, '[]');
}

// Funções auxiliares (mantidas as mesmas)
function readUsersFromFile() {
  try {
    return JSON.parse(fs.readFileSync(usersFilePath, 'utf8'));
  } catch (error) {
    return [];
  }
}

function saveUsersToFile(users) {
  fs.writeFileSync(usersFilePath, JSON.stringify(users, null, 2));
}

function readPagamentosFromFile() {
  try {
    return JSON.parse(fs.readFileSync(pagamentosPath, 'utf8'));
  } catch (error) {
    return [];
  }
}

function savePagamentosToFile(pagamentos) {
  fs.writeFileSync(pagamentosPath, JSON.stringify(pagamentos, null, 2));
}

function logWebhook(data) {
  const logEntry = `${new Date().toISOString()} - ${JSON.stringify(data)}\n`;
  fs.appendFileSync(webhooksLogPath, logEntry, 'utf8');
}

// ==================== AUTENTICAÇÃO ====================
app.post('/register', (req, res) => {
  const { username, password } = req.body;
  const users = readUsersFromFile();
  if (users.find(u => u.username === username)) {
    return res.status(400).json({ message: 'Usuário já existe' });
  }
  users.push({ username, password });
  saveUsersToFile(users);
  res.status(201).json({ message: 'Usuário registrado com sucesso!' });
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  const users = readUsersFromFile();
  const user = users.find(u => u.username === username && u.password === password);
  if (!user) {
    return res.status(401).json({ success: false, message: 'Credenciais inválidas' });
  }
  const { password: _, ...userWithoutPassword } = user;
  res.status(200).json({ success: true, message: 'Login bem-sucedido!', user: userWithoutPassword });
});

// ==================== CRIAR PAGAMENTO - PUSHINPAY PIX ====================
app.post('/criar-pagamento', async (req, res) => {
  const { valor, descricao, entregavelUrl, cliente, produto, orderBumps } = req.body;

  if (!valor || isNaN(valor)) {
    return res.status(400).json({ error: 'Valor inválido ou não informado' });
  }

  try {
    const response = await axios.post(`${PUSHINPAY_BASE_URL}/pix`, {
      amount: parseFloat(valor),
      description: descricao || `Pagamento - ${produto || 'Produto não especificado'}`,
      callback_url: WEBHOOK_URL // Usando a constante definida acima
    }, {
      headers: {
        'Authorization': `Bearer ${PUSHINPAY_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    const data = response.data;
    console.log('Resposta da PushinPay:', data);

    let pagamentos = readPagamentosFromFile();
    
    const novoPagamento = {
      id: data.id,
      transactionId: data.id,
      amount: parseFloat(valor),
      status: 'PENDING',
      qrCodeUrl: data.qrcode_url,
      qrCodeText: data.qrcode,
      qrcode: data.qrcode,
      entregavelUrl,
      cliente,
      produto,
      orderBumps,
      dataCriacao: new Date().toISOString(),
      expiration: data.expiration,
      payer: data.payer // Informações do pagador, se disponíveis
    };

    pagamentos.push(novoPagamento);
    savePagamentosToFile(pagamentos);

    res.json({
      success: true,
      qrCodeUrl: data.qrcode_url,
      qrCodeText: data.qrcode,
      payload: data.qrcode,
      transactionId: data.id,
      transaction_id: data.id,
      id: data.id,
      expiration: data.expiration,
      payer: data.payer
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

// ==================== WEBHOOK PUSHINPAY ====================
app.post('/webhook/pix', (req, res) => {
  logWebhook(req.body);
  
  const paymentId = req.body.id || req.body.transaction_id;
  const { status, amount, payer } = req.body;

  if (!paymentId) {
    console.error('Webhook sem ID válido:', req.body);
    return res.sendStatus(400);
  }

  if (status === 'PAID') {
    const pagamentos = readPagamentosFromFile();
    const pagamentoIndex = pagamentos.findIndex(p => p.id === paymentId);

    if (pagamentoIndex !== -1) {
      pagamentos[pagamentoIndex].status = 'PAID';
      pagamentos[pagamentoIndex].dataConfirmacao = new Date().toISOString();
      pagamentos[pagamentoIndex].payer = payer || pagamentos[pagamentoIndex].payer;
      savePagamentosToFile(pagamentos);
      console.log(`Pagamento ${paymentId} confirmado!`);
    } else {
      const novoPagamento = {
        id: paymentId,
        amount: amount || 0,
        status: 'PAID',
        dataConfirmacao: new Date().toISOString(),
        payer: payer || null,
        notFound: true
      };
      pagamentos.push(novoPagamento);
      savePagamentosToFile(pagamentos);
      console.log(`Pagamento ${paymentId} confirmado, mas não estava no sistema!`);
    }
  }

  res.sendStatus(200);
});

// ==================== ENDPOINTS ADICIONAIS ====================
app.get('/pagamentos', (req, res) => {
  const pagamentos = readPagamentosFromFile();
  res.json(pagamentos);
});

app.get('/pagamentos/:id', (req, res) => {
  const pagamentos = readPagamentosFromFile();
  const pagamento = pagamentos.find(p => p.id === req.params.id);
  
  if (!pagamento) {
    return res.status(404).json({ error: 'Pagamento não encontrado' });
  }
  
  res.json(pagamento);
});

app.get('/webhooks-log', (req, res) => {
  try {
    const logs = fs.readFileSync(webhooksLogPath, 'utf8');
    res.type('text').send(logs);
  } catch (error) {
    res.status(404).json({ error: 'Log não encontrado' });
  }
});

app.get('/verificar-status', (req, res) => {
  const { transactionId } = req.query;

  if (!transactionId) {
    return res.status(400).json({ 
      success: false,
      error: 'Transaction ID não fornecido' 
    });
  }

  const pagamentos = readPagamentosFromFile();
  const pagamento = pagamentos.find(p => p.id === transactionId);

  if (!pagamento) {
    return res.status(404).json({ 
      success: false,
      status: 'NOT_FOUND', 
      message: 'Pagamento não encontrado' 
    });
  }

  res.json({
    success: true,
    status: pagamento.status,
    transactionId: pagamento.id,
    amount: pagamento.amount,
    ...(pagamento.status === 'PAID' && { 
      urlEntregavel: pagamento.entregavelUrl,
      dataConfirmacao: pagamento.dataConfirmacao,
      payer: pagamento.payer
    }),
    dataCriacao: pagamento.dataCriacao,
    expiration: pagamento.expiration
  });
});

// ==================== INICIAR SERVIDOR ====================
app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
  console.log(`Webhook configurado para: ${WEBHOOK_URL}`);
});

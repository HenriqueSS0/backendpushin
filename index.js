import express from 'express';
import axios from 'axios';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Get __dirname equivalent in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const PUSHINPAY_API_KEY = '253e4917e0af56f093b2d5c26349cd7c:eba256e2e9b6b0d3578c20c38fe89e43c8d860bb7c4f92b0090714f0152dc2eaaf417a10ac4ac0242a08bed6c202cd15574e11779902:362c22215b3a3f52935c498c6e71b4ee';
const PUSHINPAY_BASE_URL = 'https://api.pushinpay.com.br/api';
const WEBHOOK_URL = 'https://backendpushin.onrender.com/webhook/pix';

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const usersFilePath = path.join(__dirname, 'users.json');
const pagamentosPath = path.join(__dirname, 'pagamentos.json');
const webhooksLogPath = path.join(__dirname, 'webhooks.log');

// Ensure files exist on startup
if (!fs.existsSync(usersFilePath)) {
  fs.writeFileSync(usersFilePath, '[]');
}
if (!fs.existsSync(pagamentosPath)) {
  fs.writeFileSync(pagamentosPath, '[]');
}
if (!fs.existsSync(webhooksLogPath)) {
  fs.writeFileSync(webhooksLogPath, '');
}

// Helper functions
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

// ==================== AUTHENTICATION ====================
app.post('/register', (req, res) => {
  const { username, password } = req.body;
  const users = readUsersFromFile();
  
  if (!username || !password) {
    return res.status(400).json({ success: false, message: 'Username e password são obrigatórios' });
  }
  
  if (users.find(u => u.username === username)) {
    return res.status(400).json({ success: false, message: 'Usuário já existe' });
  }
  
  users.push({ username, password });
  saveUsersToFile(users);
  res.status(201).json({ success: true, message: 'Usuário registrado com sucesso!' });
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  const users = readUsersFromFile();
  
  if (!username || !password) {
    return res.status(400).json({ success: false, message: 'Username e password são obrigatórios' });
  }
  
  const user = users.find(u => u.username === username && u.password === password);
  if (!user) {
    return res.status(401).json({ success: false, message: 'Credenciais inválidas' });
  }
  
  const { password: _, ...userWithoutPassword } = user;
  res.status(200).json({ 
    success: true, 
    message: 'Login bem-sucedido!', 
    user: userWithoutPassword 
  });
});

// ==================== PIX PAYMENT ====================
app.post('/criar-pagamento', async (req, res) => {
  const { valor, descricao, entregavelUrl, cliente, produto, orderBumps } = req.body;

  // Validation
  if (!valor || isNaN(valor)) {
    return res.status(400).json({ 
      success: false,
      error: 'Valor inválido ou não informado' 
    });
  }

  // Prepare payload
  const payload = {
    amount: parseFloat(valor),
    description: descricao || `Pagamento - ${produto || 'Produto não especificado'}`,
    callback_url: WEBHOOK_URL
  };

  // Add payer info if available
  if (cliente) {
    payload.payer = {
      name: cliente.nome || '',
      email: cliente.email || '',
      document: cliente.cpf || ''
    };
  }

  try {
    // Try primary endpoint first
    const response = await axios.post(`${PUSHINPAY_BASE_URL}/pix/cashIn`, payload, {
      headers: {
        'Authorization': `Basic ${PUSHINPAY_API_KEY}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      timeout: 10000 // 10 seconds timeout
    });

    const data = response.data;
    console.log('PushinPay API Response:', data);

    // Prepare payment record
    const novoPagamento = {
      id: data.id,
      transactionId: data.id,
      amount: parseFloat(valor),
      status: 'PENDING',
      qrCodeUrl: data.qrcode_url || data.qr_code_url,
      qrCodeText: data.qrcode || data.qr_code,
      qrcode: data.qrcode || data.qr_code,
      entregavelUrl,
      cliente,
      produto,
      orderBumps,
      dataCriacao: new Date().toISOString(),
      expiration: data.expiration || data.expires_in,
      payer: data.payer || payload.payer
    };

    // Save to database
    let pagamentos = readPagamentosFromFile();
    pagamentos.push(novoPagamento);
    savePagamentosToFile(pagamentos);

    // Return success response
    res.json({
      success: true,
      qrCodeUrl: novoPagamento.qrCodeUrl,
      qrCodeText: novoPagamento.qrCodeText,
      payload: novoPagamento.qrcode,
      transactionId: data.id,
      expiration: novoPagamento.expiration,
      payer: novoPagamento.payer
    });

  } catch (error) {
    console.error('Payment Error:', error.response?.data || error.message);
    
    // Prepare error response
    const errorResponse = {
      success: false,
      error: 'Erro ao criar pagamento',
      detalhes: error.response?.data || error.message
    };

    // Add additional debug info
    if (error.response) {
      errorResponse.statusCode = error.response.status;
      errorResponse.apiResponse = error.response.data;
    }

    res.status(error.response?.status || 500).json(errorResponse);
  }
});

// ==================== WEBHOOK ====================
app.post('/webhook/pix', (req, res) => {
  logWebhook(req.body);
  
  const paymentId = req.body.id || req.body.transaction_id;
  const { status, amount, payer } = req.body;

  if (!paymentId) {
    console.error('Invalid webhook:', req.body);
    return res.status(400).json({ error: 'ID do pagamento não fornecido' });
  }

  try {
    const pagamentos = readPagamentosFromFile();
    const pagamentoIndex = pagamentos.findIndex(p => p.id === paymentId);

    if (status === 'PAID') {
      if (pagamentoIndex !== -1) {
        // Update existing payment
        pagamentos[pagamentoIndex] = {
          ...pagamentos[pagamentoIndex],
          status: 'PAID',
          dataConfirmacao: new Date().toISOString(),
          payer: payer || pagamentos[pagamentoIndex].payer
        };
      } else {
        // Create new payment record if not found
        pagamentos.push({
          id: paymentId,
          amount: amount || 0,
          status: 'PAID',
          dataConfirmacao: new Date().toISOString(),
          payer: payer || null,
          dataCriacao: new Date().toISOString()
        });
      }
      
      savePagamentosToFile(pagamentos);
      console.log(`Payment ${paymentId} confirmed`);
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('Webhook processing error:', error);
    res.status(500).json({ error: 'Erro ao processar webhook' });
  }
});

// ==================== PAYMENT STATUS ====================
app.get('/pagamentos', (req, res) => {
  try {
    const pagamentos = readPagamentosFromFile();
    res.json({ success: true, data: pagamentos });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Erro ao buscar pagamentos' });
  }
});

app.get('/pagamentos/:id', (req, res) => {
  try {
    const pagamentos = readPagamentosFromFile();
    const pagamento = pagamentos.find(p => p.id === req.params.id);
    
    if (!pagamento) {
      return res.status(404).json({ 
        success: false, 
        error: 'Pagamento não encontrado' 
      });
    }
    
    res.json({ success: true, data: pagamento });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Erro ao buscar pagamento' });
  }
});

app.get('/verificar-status', (req, res) => {
  try {
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
      dataCriacao: pagamento.dataCriacao,
      ...(pagamento.status === 'PAID' && { 
        dataConfirmacao: pagamento.dataConfirmacao,
        payer: pagamento.payer,
        urlEntregavel: pagamento.entregavelUrl
      }),
      ...(pagamento.status === 'PENDING' && {
        qrCodeUrl: pagamento.qrCodeUrl,
        expiration: pagamento.expiration
      })
    });
  } catch (error) {
    res.status(500).json({ 
      success: false,
      error: 'Erro ao verificar status' 
    });
  }
});

// ==================== UTILITY ENDPOINTS ====================
app.get('/webhooks-log', (req, res) => {
  try {
    const logs = fs.readFileSync(webhooksLogPath, 'utf8');
    res.type('text').send(logs);
  } catch (error) {
    res.status(500).json({ success: false, error: 'Erro ao ler logs' });
  }
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    timestamp: new Date().toISOString(),
    service: 'PushinPay Integration',
    version: '1.0.0'
  });
});

// ==================== ERROR HANDLING ====================
app.use((req, res, next) => {
  res.status(404).json({ success: false, error: 'Endpoint não encontrado' });
});

app.use((err, req, res, next) => {
  console.error('Server Error:', err);
  res.status(500).json({ 
    success: false, 
    error: 'Erro interno no servidor' 
  });
});

// ==================== START SERVER ====================
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  console.log(`Webhook configurado para: ${WEBHOOK_URL}`);
  console.log(`Modo: ${process.env.NODE_ENV || 'development'}`);
});

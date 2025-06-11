const express = require('express');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const API_TOKEN = '33108|m5F54MDdH4l8W7Wj2vCuuA0hDN7IU7yvhF6mzwzU5ad0138a';

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const usersFilePath = path.join(__dirname, 'users.json');
const pagamentosPath = path.join(__dirname, 'pagamentos.json');
const webhooksLogPath = path.join(__dirname, 'webhooks.log');

// Inicializar arquivos se não existirem
if (!fs.existsSync(usersFilePath)) fs.writeFileSync(usersFilePath, '[]');
if (!fs.existsSync(pagamentosPath)) fs.writeFileSync(pagamentosPath, '[]');
if (!fs.existsSync(webhooksLogPath)) fs.writeFileSync(webhooksLogPath, '');

// Funções auxiliares
function readUsersFromFile() {
  try {
    return JSON.parse(fs.readFileSync(usersFilePath, 'utf8'));
  } catch (error) {
    console.error('Erro ao ler usuários:', error);
    return [];
  }
}

function saveUsersToFile(users) {
  try {
    fs.writeFileSync(usersFilePath, JSON.stringify(users, null, 2));
  } catch (error) {
    console.error('Erro ao salvar usuários:', error);
  }
}

function readPagamentosFromFile() {
  try {
    return JSON.parse(fs.readFileSync(pagamentosPath, 'utf8'));
  } catch (error) {
    console.error('Erro ao ler pagamentos:', error);
    return [];
  }
}

function savePagamentosToFile(pagamentos) {
  try {
    fs.writeFileSync(pagamentosPath, JSON.stringify(pagamentos, null, 2));
  } catch (error) {
    console.error('Erro ao salvar pagamentos:', error);
  }
}

function logWebhook(data) {
  try {
    const logEntry = `${new Date().toISOString()} - ${JSON.stringify(data)}\n`;
    fs.appendFileSync(webhooksLogPath, logEntry, 'utf8');
  } catch (error) {
    console.error('Erro ao registrar webhook:', error);
  }
}

// Rotas
app.post('/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ message: 'Username e password são obrigatórios' });
  }

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
  if (!username || !password) {
    return res.status(400).json({ message: 'Username e password são obrigatórios' });
  }

  const users = readUsersFromFile();
  const user = users.find(u => u.username === username && u.password === password);
  
  if (!user) {
    return res.status(401).json({ success: false, message: 'Credenciais inválidas' });
  }

  const { password: _, ...userWithoutPassword } = user;
  res.status(200).json({ success: true, message: 'Login bem-sucedido!', user: userWithoutPassword });
});

app.post('/criar-pagamento', async (req, res) => {
  const { valor, descricao, entregavelUrl, cliente, produto, orderBumps } = req.body;

  console.log('Dados recebidos:', { valor, descricao, entregavelUrl, cliente, produto, orderBumps });

  // Validações
  if (valor === undefined || valor === null || isNaN(valor)) {
    return res.status(400).json({ 
      success: false,
      error: 'Valor inválido ou não informado' 
    });
  }

  if (!cliente || !cliente.nome || !cliente.email) {
    return res.status(400).json({ 
      success: false,
      error: 'Dados do cliente incompletos' 
    });
  }

  // Garantir que o valor está correto (não converter de centavos se já está em reais)
  const valorFinal = parseFloat(valor);

  try {
    console.log('Enviando para PushinPay:', {
      value: valorFinal,
      description: descricao || `Pagamento - ${produto || 'Produto não especificado'}`,
      callbackUrl: 'https://backendpushin.onrender.com/webhook/pix'
    });

    const response = await axios.post('https://api.pushinpay.com.br/api/pix/cashIn', {
      value: valorFinal,
      description: descricao || `Pagamento - ${produto || 'Produto não especificado'}`,
      callbackUrl: 'https://backendpushin.onrender.com/webhook/pix'
    }, {
      headers: {
        'Authorization': `Bearer ${API_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });

    const responseData = response.data;
    console.log('Resposta da PushinPay:', responseData);

    // Validar se recebemos os dados necessários
    if (!responseData.transactionId) {
      console.error('TransactionId não retornado pela API:', responseData);
      return res.status(500).json({
        success: false,
        error: 'API de pagamento não retornou ID da transação',
        detalhes: responseData
      });
    }

    if (!responseData.qrCodeText && !responseData.qrCodeImage) {
      console.error('Dados do QR Code não retornados pela API:', responseData);
      return res.status(500).json({
        success: false,
        error: 'API de pagamento não retornou dados do PIX',
        detalhes: responseData
      });
    }

    // Salvar no histórico de pagamentos
    const pagamentos = readPagamentosFromFile();
    const novoPagamento = {
      id: responseData.transactionId,
      transactionId: responseData.transactionId,
      amount: valorFinal,
      status: 'PENDING',
      qr_code: responseData.qrCodeText,
      qr_code_base64: responseData.qrCodeImage,
      value: valorFinal,
      entregavelUrl,
      cliente,
      produto,
      orderBumps,
      dataCriacao: new Date().toISOString()
    };

    pagamentos.push(novoPagamento);
    savePagamentosToFile(pagamentos);

    // Retornar resposta padronizada para o frontend
    const responseToFrontend = {
      success: true,
      id: responseData.transactionId,
      qr_code: responseData.qrCodeText,
      qr_code_base64: responseData.qrCodeImage,
      status: 'pending',
      value: valorFinal,
      transactionId: responseData.transactionId
    };

    console.log('Enviando para frontend:', responseToFrontend);
    res.json(responseToFrontend);

  } catch (error) {
    console.error('Erro ao criar pagamento:', error.response?.data || error.message);
    
    let errorMessage = 'Erro ao criar pagamento';
    let statusCode = 500;
    
    if (error.response) {
      statusCode = error.response.status;
      errorMessage = error.response.data?.message || error.response.data?.error || errorMessage;
      
      // Log detalhado do erro da API externa
      console.error('Erro da API PushinPay:', {
        status: error.response.status,
        data: error.response.data,
        headers: error.response.headers
      });
    }

    res.status(statusCode).json({
      success: false,
      error: errorMessage,
      detalhes: error.response?.data || error.message
    });
  }
});

app.post('/webhook/pix', (req, res) => {
  console.log('Webhook recebido:', req.body);
  logWebhook(req.body);

  const { transactionId, status, value } = req.body;

  if (!transactionId) {
    console.error('Webhook sem transactionId:', req.body);
    return res.status(400).json({ error: 'Transaction ID não fornecido' });
  }

  const pagamentos = readPagamentosFromFile();
  const index = pagamentos.findIndex(p => p.transactionId === transactionId);

  if (status === 'PAID') {
    if (index !== -1) {
      pagamentos[index].status = 'COMPLETED';
      pagamentos[index].dataConfirmacao = new Date().toISOString();
      savePagamentosToFile(pagamentos);
      console.log(`✅ Pagamento ${transactionId} confirmado!`);
    } else {
      // Criar entrada para pagamento não encontrado
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
  } else if (status === 'EXPIRED') {
    if (index !== -1) {
      pagamentos[index].status = 'EXPIRED';
      pagamentos[index].dataExpiracao = new Date().toISOString();
      savePagamentosToFile(pagamentos);
      console.log(`❌ Pagamento ${transactionId} expirado!`);
    }
  }

  res.sendStatus(200);
});

app.get('/verificar-status', (req, res) => {
  const { transactionId } = req.query;

  console.log('Verificando status para:', transactionId);

  if (!transactionId) {
    return res.status(400).json({ 
      success: false, 
      error: 'Transaction ID não fornecido' 
    });
  }

  const pagamentos = readPagamentosFromFile();
  const pagamento = pagamentos.find(p => p.transactionId === transactionId);

  if (!pagamento) {
    console.log('Pagamento não encontrado:', transactionId);
    return res.status(404).json({ 
      success: false, 
      status: 'NOT_FOUND', 
      message: 'Pagamento não encontrado' 
    });
  }

  const response = {
    success: true,
    status: pagamento.status,
    transactionId: pagamento.transactionId,
    amount: pagamento.amount,
    dataCriacao: pagamento.dataCriacao,
    qr_code: pagamento.qr_code,
    qr_code_base64: pagamento.qr_code_base64
  };

  // Adicionar URL do entregável apenas se o pagamento foi completado
  if (pagamento.status === 'COMPLETED' && pagamento.entregavelUrl) {
    response.urlEntregavel = pagamento.entregavelUrl;
    response.dataConfirmacao = pagamento.dataConfirmacao;
  }

  console.log('Status retornado:', response);
  res.json(response);
});

// Nova rota para verificar status via API externa (opcional)
app.get('/verificar-status-externo', async (req, res) => {
  const { transactionId } = req.query;

  if (!transactionId) {
    return res.status(400).json({ 
      success: false, 
      error: 'Transaction ID não fornecido' 
    });
  }

  try {
    // Tentar verificar status na API externa
    const response = await axios.get(`https://api.pushinpay.com.br/api/pix/status/${transactionId}`, {
      headers: {
        'Authorization': `Bearer ${API_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });

    const statusData = response.data;
    
    // Atualizar status local se necessário
    const pagamentos = readPagamentosFromFile();
    const index = pagamentos.findIndex(p => p.transactionId === transactionId);
    
    if (index !== -1 && statusData.status === 'PAID' && pagamentos[index].status !== 'COMPLETED') {
      pagamentos[index].status = 'COMPLETED';
      pagamentos[index].dataConfirmacao = new Date().toISOString();
      savePagamentosToFile(pagamentos);
    }

    res.json({
      success: true,
      status: statusData.status === 'PAID' ? 'COMPLETED' : statusData.status,
      transactionId: transactionId,
      externalData: statusData
    });

  } catch (error) {
    console.error('Erro ao verificar status externo:', error.response?.data || error.message);
    
    // Fallback para verificação local
    const pagamentos = readPagamentosFromFile();
    const pagamento = pagamentos.find(p => p.transactionId === transactionId);
    
    if (pagamento) {
      res.json({
        success: true,
        status: pagamento.status,
        transactionId: pagamento.transactionId,
        fallback: true
      });
    } else {
      res.status(404).json({
        success: false,
        error: 'Pagamento não encontrado'
      });
    }
  }
});

app.get('/pagamentos', (req, res) => {
  try {
    const pagamentos = readPagamentosFromFile();
    res.json({
      success: true,
      data: pagamentos,
      count: pagamentos.length
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Erro ao recuperar pagamentos'
    });
  }
});

app.get('/webhooks-log', (req, res) => {
  try {
    const logs = fs.readFileSync(webhooksLogPath, 'utf8');
    res.type('text').send(logs);
  } catch (error) {
    res.status(500).json({ 
      success: false,
      error: 'Erro ao ler logs',
      detalhes: error.message 
    });
  }
});

// Rota de health check
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Middleware de tratamento de erros
app.use((err, req, res, next) => {
  console.error('Erro interno:', err);
  res.status(500).json({
    success: false,
    error: 'Erro interno no servidor',
    timestamp: new Date().toISOString()
  });
});

// Middleware para rotas não encontradas
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    error: 'Rota não encontrada',
    path: req.originalUrl
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando em http://localhost:${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/health`);
});

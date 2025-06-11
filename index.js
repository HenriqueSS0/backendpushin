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
    console.log('Webhook logged:', data);
  } catch (error) {
    console.error('Erro ao registrar webhook:', error);
  }
}

// Função para atualizar status local
function atualizarStatusLocal(transactionId, novoStatus, valor = null) {
  const pagamentos = readPagamentosFromFile();
  const index = pagamentos.findIndex(p => p.transactionId === transactionId);
  
  if (index !== -1) {
    const statusAnterior = pagamentos[index].status;
    pagamentos[index].status = novoStatus;
    
    if (novoStatus === 'COMPLETED') {
      pagamentos[index].dataConfirmacao = new Date().toISOString();
    } else if (novoStatus === 'EXPIRED') {
      pagamentos[index].dataExpiracao = new Date().toISOString();
    }
    
    if (valor) {
      pagamentos[index].amount = valor;
      pagamentos[index].value = valor;
    }
    
    savePagamentosToFile(pagamentos);
    console.log(`✅ Status atualizado: ${transactionId} - ${statusAnterior} → ${novoStatus}`);
    return true;
  }
  
  console.log(`⚠️ Pagamento não encontrado para atualização: ${transactionId}`);
  return false;
}

// Rotas existentes...
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

    if (!responseData.qr_code && !responseData.qr_code_base64) {
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
      id: responseData.id || responseData.transactionId,
      transactionId: responseData.id || responseData.transactionId,
      amount: valorFinal,
      status: 'PENDING',
      qr_code: responseData.qr_code,
      qr_code_base64: responseData.qr_code_base64,
      value: valorFinal,
      entregavelUrl,
      cliente,
      produto,
      orderBumps,
      dataCriacao: new Date().toISOString()
    };

    pagamentos.push(novoPagamento);
    savePagamentosToFile(pagamentos);

    const responseToFrontend = {
      success: true,
      id: responseData.id || responseData.transactionId,
      qr_code: responseData.qr_code,
      qr_code_base64: responseData.qr_code_base64,
      status: 'pending',
      value: valorFinal,
      transactionId: responseData.id || responseData.transactionId
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
    }

    res.status(statusCode).json({
      success: false,
      error: errorMessage,
      detalhes: error.response?.data || error.message
    });
  }
});

// WEBHOOK CORRIGIDO PARA PUSHINPAY
app.post('/webhook/pix', (req, res) => {
  console.log('=== WEBHOOK PUSHINPAY RECEBIDO ===');
  console.log('Headers:', req.headers);
  console.log('Body completo:', JSON.stringify(req.body, null, 2));
  console.log('==================================');
  
  logWebhook(req.body);

  // Formato específico da PushinPay
  const transactionId = req.body.id || req.body.transactionId || req.body.transaction_id;
  const status = req.body.status;
  const value = req.body.value || req.body.amount;

  console.log('Dados extraídos do webhook PushinPay:', { transactionId, status, value });

  if (!transactionId) {
    console.error('❌ Webhook sem ID de transação:', req.body);
    return res.status(400).json({ error: 'ID de transação não fornecido' });
  }

  // Status específicos da PushinPay
  if (status === 'PAID' || status === 'COMPLETED' || status === 'CONFIRMED') {
    console.log(`✅ PushinPay: Pagamento confirmado para ${transactionId}`);
    atualizarStatusLocal(transactionId, 'COMPLETED', value);
  } else if (status === 'EXPIRED' || status === 'CANCELLED' || status === 'FAILED') {
    console.log(`❌ PushinPay: Pagamento expirado/cancelado para ${transactionId}`);
    atualizarStatusLocal(transactionId, 'EXPIRED');
  } else if (status === 'PENDING' || status === 'WAITING') {
    console.log(`⏳ PushinPay: Pagamento pendente para ${transactionId}`);
    // Mantém como PENDING
  } else {
    console.log(`⚠️ PushinPay: Status desconhecido recebido: ${status} para ${transactionId}`);
  }

  res.status(200).json({ success: true, message: 'Webhook processado' });
});

// ROTA PARA VERIFICAR STATUS COM CONSULTA À API CORRIGIDA
app.get('/verificar-status', async (req, res) => {
  const { transactionId } = req.query;

  console.log(`🔍 Verificando status para: ${transactionId}`);

  if (!transactionId) {
    return res.status(400).json({ 
      success: false, 
      error: 'Transaction ID não fornecido' 
    });
  }

  // Verificar no banco local primeiro
  const pagamentos = readPagamentosFromFile();
  let pagamento = pagamentos.find(p => p.transactionId === transactionId);

  if (!pagamento) {
    console.log('❌ Pagamento não encontrado:', transactionId);
    return res.status(404).json({ 
      success: false, 
      status: 'NOT_FOUND', 
      message: 'Pagamento não encontrado' 
    });
  }

  // Se ainda está PENDING, consultar a API da PushinPay com o endpoint correto
  if (pagamento.status === 'PENDING') {
    try {
      console.log(`🔄 Consultando API PushinPay para: ${transactionId}`);
      
      // ENDPOINT CORRETO: /api/transactions/{ID} em vez de /api/pix/status/{ID}
      const apiResponse = await axios.get(`https://api.pushinpay.com.br/api/transactions/${transactionId}`, {
        headers: {
          'Authorization': `Bearer ${API_TOKEN}`,
          'Content-Type': 'application/json'
        }
      });

      const apiData = apiResponse.data;
      console.log('📡 Resposta da API PushinPay:', apiData);

      // Atualizar status baseado na resposta da API
      if (apiData.status === 'PAID' || apiData.status === 'COMPLETED') {
        console.log(`✅ API confirma pagamento para ${transactionId}`);
        atualizarStatusLocal(transactionId, 'COMPLETED', apiData.value);
        pagamento.status = 'COMPLETED';
        pagamento.dataConfirmacao = new Date().toISOString();
      } else if (apiData.status === 'EXPIRED' || apiData.status === 'CANCELLED') {
        console.log(`❌ API confirma expiração para ${transactionId}`);
        atualizarStatusLocal(transactionId, 'EXPIRED');
        pagamento.status = 'EXPIRED';
        pagamento.dataExpiracao = new Date().toISOString();
      }

    } catch (error) {
      console.error('❌ Erro ao consultar API PushinPay:', error.response?.data || error.message);
      // Continua com o status local se a API falhar
    }
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

  // Adicionar URL do entregável se pagamento foi completado
  if (pagamento.status === 'COMPLETED' && pagamento.entregavelUrl) {
    response.urlEntregavel = pagamento.entregavelUrl;
    response.dataConfirmacao = pagamento.dataConfirmacao;
  }

  console.log('📊 Status final retornado:', response);
  res.json(response);
});

// ROTA PARA FORÇAR STATUS MANUALMENTE
app.post('/forcar-status/:transactionId', (req, res) => {
  const { transactionId } = req.params;
  const { status } = req.body;
  
  if (!['COMPLETED', 'EXPIRED', 'PENDING'].includes(status)) {
    return res.status(400).json({
      success: false,
      error: 'Status deve ser COMPLETED, EXPIRED ou PENDING'
    });
  }
  
  console.log(`⚡ Forçando status ${status} para: ${transactionId}`);
  
  const atualizado = atualizarStatusLocal(transactionId, status);
  
  if (atualizado) {
    res.json({
      success: true,
      message: `Status forçado para ${status}`,
      transactionId,
      novoStatus: status
    });
  } else {
    res.status(404).json({
      success: false,
      error: 'Pagamento não encontrado'
    });
  }
});

// ROTA PARA MARCAR COMO PAGO RAPIDAMENTE
app.post('/marcar-como-pago/:transactionId', (req, res) => {
  const { transactionId } = req.params;
  
  console.log(`💰 Marcando como PAGO: ${transactionId}`);
  
  const atualizado = atualizarStatusLocal(transactionId, 'COMPLETED');
  
  if (atualizado) {
    res.json({
      success: true,
      message: `Pagamento ${transactionId} marcado como PAGO!`,
      transactionId,
      status: 'COMPLETED'
    });
  } else {
    res.status(404).json({
      success: false,
      error: 'Pagamento não encontrado'
    });
  }
});

// ROTA PARA LISTAR PAGAMENTOS PENDENTES
app.get('/pagamentos-pendentes', (req, res) => {
  try {
    const pagamentos = readPagamentosFromFile();
    const pendentes = pagamentos.filter(p => p.status === 'PENDING');
    
    res.json({
      success: true,
      data: pendentes,
      count: pendentes.length,
      message: `${pendentes.length} pagamentos pendentes encontrados`
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Erro ao recuperar pagamentos pendentes'
    });
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

// ROTA PARA DEBUG - LISTAR TODOS OS WEBHOOKS RECEBIDOS
app.get('/debug/webhooks', (req, res) => {
  try {
    const logs = fs.readFileSync(webhooksLogPath, 'utf8');
    const linhas = logs.trim().split('\n').filter(linha => linha.length > 0);
    
    const webhooks = linhas.map(linha => {
      try {
        const [timestamp, ...jsonParts] = linha.split(' - ');
        const jsonString = jsonParts.join(' - ');
        return {
          timestamp,
          data: JSON.parse(jsonString)
        };
      } catch (e) {
        return {
          timestamp: 'unknown',
          data: linha,
          parseError: true
        };
      }
    });
    
    res.json({
      success: true,
      totalWebhooks: webhooks.length,
      webhooks: webhooks.slice(-50) // Últimos 50
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Erro ao analisar logs de webhook'
    });
  }
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
  console.log(`📡 Webhook URL: http://localhost:${PORT}/webhook/pix`);
  console.log(`🔍 Para testar: http://localhost:${PORT}/health`);
});

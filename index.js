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
const PUSHINPAY_API_KEY = '253e4917e0af56f093b2d5c26349cd7c:eba256e2e9b6b0d3578c20c38fe89e43c8d860bb7c4f92b0090714f0152dc2eaaf417a10ac4ac0242a08bed6c202cd15574e11779902:362c22215b3a3f52935c498c6e71b4ee'; // Substitua pelo seu token real
const PUSHINPAY_BASE_URL = 'https://api.pushinpay.com.br/api';
const WEBHOOK_URL = 'https://backendpushin.onrender.com/webhook/pix';

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const usersFilePath = path.join(__dirname, 'users.json');
const pagamentosPath = path.join(__dirname, 'pagamentos.json');
const webhooksLogPath = path.join(__dirname, 'webhooks.log');

// Ensure files exist on startup
[usersFilePath, pagamentosPath, webhooksLogPath].forEach(filePath => {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, filePath.endsWith('.json') ? '[]' : '');
  }
});

// Helper functions
const readJSONFile = (filePath) => {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    return filePath.endsWith('users.json') ? [] : [];
  }
};

const saveJSONFile = (filePath, data) => {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
};

const logWebhook = (data) => {
  const logEntry = `${new Date().toISOString()} - ${JSON.stringify(data)}\n`;
  fs.appendFileSync(webhooksLogPath, logEntry, 'utf8');
};

// ==================== PIX PAYMENT ====================
app.post('/criar-pagamento', async (req, res) => {
  const { valor, descricao, entregavelUrl, cliente, produto } = req.body;

  // Validação
  if (!valor || isNaN(valor)) {
    return res.status(400).json({ 
      success: false,
      error: 'Valor inválido ou não informado' 
    });
  }

  // Converter para centavos e garantir que é inteiro
  const valorCentavos = Math.round(parseFloat(valor) * 100);
  
  if (valorCentavos < 50) {
    return res.status(400).json({
      success: false,
      error: 'Valor mínimo é de 50 centavos (R$ 0,50)'
    });
  }

  // Payload correto conforme documentação da Pushin Pay
  const payload = {
    value: valorCentavos, // EM CENTAVOS e INTEIRO
    webhook_url: WEBHOOK_URL,
    ...(descricao && { description: descricao }),
    ...(cliente && {
      payer_name: cliente.nome,
      payer_national_registration: cliente.cpf
    })
  };

  try {
    const response = await axios.post(`${PUSHINPAY_BASE_URL}/pix/cashIn`, payload, {
      headers: {
        'Authorization': `Bearer ${PUSHINPAY_API_KEY}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      timeout: 10000
    });

    const data = response.data;
    console.log('PushinPay API Response:', data);

    // Preparar registro do pagamento
    const novoPagamento = {
      id: data.id,
      transactionId: data.id,
      amount: valorCentavos / 100, // Converter de volta para reais
      status: 'created', // Usar status da API (created, paid, expired)
      qr_code: data.qr_code, // Código PIX completo
      qr_code_base64: data.qr_code_base64, // QR Code em base64
      descricao,
      entregavelUrl,
      cliente,
      produto,
      dataCriacao: new Date().toISOString(),
      status_api: data.status,
      payer: {
        name: data.payer_name,
        cpf: data.payer_national_registration
      }
    };

    // Salvar no "banco de dados"
    const pagamentos = readJSONFile(pagamentosPath);
    pagamentos.push(novoPagamento);
    saveJSONFile(pagamentosPath, pagamentos);

    // Retornar resposta
    res.json({
      success: true,
      id: data.id,
      qr_code: data.qr_code,
      qr_code_base64: data.qr_code_base64,
      valor: valorCentavos / 100,
      status: data.status,
      payer: novoPagamento.payer
    });

  } catch (error) {
    console.error('Erro na API PushinPay:', error.response?.data || error.message);
    
    let errorMessage = 'Erro ao criar pagamento';
    let statusCode = 500;
    
    if (error.response) {
      statusCode = error.response.status;
      if (error.response.data) {
        errorMessage = error.response.data.error || JSON.stringify(error.response.data);
      }
    }

    res.status(statusCode).json({
      success: false,
      error: errorMessage,
      ...(error.response?.data && { details: error.response.data })
    });
  }
});
// ==================== WEBHOOK ====================
app.post('/webhook/pix', (req, res) => {
  logWebhook(req.body);
  
  const paymentData = req.body;
  const paymentId = paymentData.id;
  const status = paymentData.status;

  if (!paymentId) {
    console.error('Webhook inválido:', paymentData);
    return res.status(400).json({ error: 'ID do pagamento não fornecido' });
  }

  try {
    const pagamentos = readJSONFile(pagamentosPath);
    const pagamentoIndex = pagamentos.findIndex(p => p.id === paymentId);

    if (pagamentoIndex !== -1) {
      // Atualizar pagamento existente
      pagamentos[pagamentoIndex] = {
        ...pagamentos[pagamentoIndex],
        status: status,
        status_api: status,
        ...(status === 'paid' && {
          dataConfirmacao: new Date().toISOString(),
          payer_name: paymentData.payer_name,
          payer_national_registration: paymentData.payer_national_registration,
          end_to_end_id: paymentData.end_to_end_id
        })
      };
      
      saveJSONFile(pagamentosPath, pagamentos);
      console.log(`Pagamento ${paymentId} atualizado para status: ${status}`);
    } else {
      console.warn(`Pagamento ${paymentId} não encontrado para atualização`);
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('Erro ao processar webhook:', error);
    res.status(500).json({ error: 'Erro ao processar webhook' });
  }
});

// ==================== PAYMENT STATUS ====================
app.get('/pagamento/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Primeiro verifica no banco local
    const pagamentos = readJSONFile(pagamentosPath);
    let pagamento = pagamentos.find(p => p.id === id);

    if (!pagamento) {
      return res.status(404).json({ 
        success: false, 
        error: 'Pagamento não encontrado localmente' 
      });
    }

    // Se o pagamento ainda não foi confirmado, consulta a API
    if (pagamento.status !== 'paid') {
      try {
        const apiResponse = await axios.get(`${PUSHINPAY_BASE_URL}/transactions/${id}`, {
          headers: {
            'Authorization': `Bearer ${PUSHINPAY_API_KEY}`,
            'Accept': 'application/json'
          },
          timeout: 5000
        });

        const apiData = apiResponse.data;
        
        // Atualiza o status local se necessário
        if (apiData.status !== pagamento.status) {
          pagamento.status = apiData.status;
          pagamento.status_api = apiData.status;
          
          if (apiData.status === 'paid') {
            pagamento.dataConfirmacao = new Date().toISOString();
            pagamento.payer_name = apiData.payer_name;
            pagamento.payer_national_registration = apiData.payer_national_registration;
            pagamento.end_to_end_id = apiData.end_to_end_id;
          }
          
          // Atualiza no "banco de dados"
          const updatedPagamentos = pagamentos.map(p => 
            p.id === id ? pagamento : p
          );
          saveJSONFile(pagamentosPath, updatedPagamentos);
        }
      } catch (apiError) {
        console.error('Erro ao consultar API PushinPay:', apiError.message);
        // Continua com os dados locais mesmo se a API falhar
      }
    }

    res.json({ 
      success: true, 
      data: pagamento 
    });

  } catch (error) {
    console.error('Erro ao verificar pagamento:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Erro ao verificar status do pagamento' 
    });
  }
});

// ... (mantenha os outros endpoints como /health, /webhooks-log, etc.)

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  console.log(`Webhook configurado para: ${WEBHOOK_URL}`);
  console.log(`Modo: ${process.env.NODE_ENV || 'development'}`);
});

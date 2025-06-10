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

// ✅ TOKEN correto via x-api-key
const PUSHINPAY_API_KEY = '33108|m5F54MDdH4l8W7Wj2vCuuA0hDN7IU7yvhF6mzwzU5ad0138a';
const PUSHINPAY_BASE_URL = 'https://api.pushinpay.com.br/api';
const WEBHOOK_URL = 'https://backendpushin.onrender.com/webhook/pix';

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const usersFilePath = path.join(__dirname, 'users.json');
const pagamentosPath = path.join(__dirname, 'pagamentos.json');
const webhooksLogPath = path.join(__dirname, 'webhooks.log');

[usersFilePath, pagamentosPath, webhooksLogPath].forEach(filePath => {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, filePath.endsWith('.json') ? '[]' : '');
  }
});

const readJSONFile = (filePath) => {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return [];
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

  if (!valor || isNaN(valor)) {
    return res.status(400).json({ success: false, error: 'Valor inválido ou não informado' });
  }

  const valorCentavos = Math.round(parseFloat(valor) * 100);

  if (valorCentavos < 50) {
    return res.status(400).json({ success: false, error: 'Valor mínimo é de 50 centavos (R$ 0,50)' });
  }

  const payload = {
    value: valorCentavos,
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
        'Authorization': 'Beater: PUSHINPAY_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      timeout: 10000
    });

    const data = response.data;

    const novoPagamento = {
      id: data.id,
      transactionId: data.id,
      amount: valorCentavos / 100,
      status: 'created',
      qr_code: data.qr_code,
      qr_code_base64: data.qr_code_base64,
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

    const pagamentos = readJSONFile(pagamentosPath);
    pagamentos.push(novoPagamento);
    saveJSONFile(pagamentosPath, pagamentos);

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

    const statusCode = error.response?.status || 500;
    const errorMessage = error.response?.data?.error || 'Erro ao criar pagamento';

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
    return res.status(400).json({ error: 'ID do pagamento não fornecido' });
  }

  try {
    const pagamentos = readJSONFile(pagamentosPath);
    const pagamentoIndex = pagamentos.findIndex(p => p.id === paymentId);

    if (pagamentoIndex !== -1) {
      pagamentos[pagamentoIndex] = {
        ...pagamentos[pagamentoIndex],
        status,
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
      console.warn(`Pagamento ${paymentId} não encontrado`);
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('Erro ao processar webhook:', error);
    res.status(500).json({ error: 'Erro ao processar webhook' });
  }
});

// ==================== PAYMENT STATUS ====================
app.get('/pagamento/:id', async (req, res) => {
  const { id } = req.params;

  const pagamentos = readJSONFile(pagamentosPath);
  let pagamento = pagamentos.find(p => p.id === id);

  if (!pagamento) {
    return res.status(404).json({ success: false, error: 'Pagamento não encontrado localmente' });
  }

  if (pagamento.status !== 'paid') {
    try {
      const apiResponse = await axios.get(`${PUSHINPAY_BASE_URL}/transactions/${id}`, {
        headers: {
          'Authorization': 'Beater: PUSHINPAY_API_KEY,
          'Accept': 'application/json'
        },
        timeout: 5000
      });

      const apiData = apiResponse.data;

      if (apiData.status !== pagamento.status) {
        pagamento.status = apiData.status;
        pagamento.status_api = apiData.status;

        if (apiData.status === 'paid') {
          pagamento.dataConfirmacao = new Date().toISOString();
          pagamento.payer_name = apiData.payer_name;
          pagamento.payer_national_registration = apiData.payer_national_registration;
          pagamento.end_to_end_id = apiData.end_to_end_id;
        }

        const updatedPagamentos = pagamentos.map(p => p.id === id ? pagamento : p);
        saveJSONFile(pagamentosPath, updatedPagamentos);
      }
    } catch (apiError) {
      console.error('Erro ao consultar API PushinPay:', apiError.message);
    }
  }

  res.json({ success: true, data: pagamento });
});

// ==================== START SERVER ====================
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  console.log(`Webhook configurado para: ${WEBHOOK_URL}`);
  console.log(`Modo: ${process.env.NODE_ENV || 'development'}`);
});

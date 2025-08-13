// bot.js — Entradas no 1º webhook (action='entradas'), sem pagamento, salva em N8N_SAVE_ENTRADAS_URL
import {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle
} from 'discord.js';
import axios from 'axios';
import express from 'express';
import fs from 'fs';
import path from 'path';

// ================== CONFIG DIRETA ==================
// URLs do N8N
const N8N_SAIDA_URL         = process.env.N8N_SAIDA_URL;         // categorias + actions + ENTRADAS (action:'entradas')
const N8N_NEXT_URL          = process.env.N8N_NEXT_URL;          // subcats (step:'subcats')
const N8N_SAVE_URL          = process.env.N8N_SAVE_URL;          // salvar SAÍDAS
const N8N_SAVE_ENTRADAS_URL = process.env.N8N_SAVE_ENTRADAS_URL; // salvar ENTRADAS (ajuste o path se quiser)

// Token do bot
const DISCORD_TOKEN         = process.env.DISCORD_TOKEN;

// Comandos
const LAUNCH_COMMAND = '!lancar';
const RELOAD_COMMAND = '!reload';

// Keep-alive simples (opcional)
const app = express();
app.get('/', (_, res) => res.send('ok'));
app.listen(process.env.PORT || 3000);

// ================== PAGAMENTOS (arquivo local) — usados só em SAÍDAS ==================
const pagamentosPath = path.join(process.cwd(), 'config', 'pagamentos.json');
function loadPagamentos() {
  try {
    const raw = fs.readFileSync(pagamentosPath, 'utf8');
    let arr = JSON.parse(raw);
    if (!Array.isArray(arr)) arr = [];
    return arr.map(s => (s ?? '').toString().trim()).filter(Boolean).slice(0, 25).map(s => s.slice(0, 80));
  } catch (e) {
    console.warn('[pagamentos] Falha ao ler config/pagamentos.json:', e.message);
    return [];
  }
}
let PAGAMENTOS = loadPagamentos();
if (fs.existsSync(pagamentosPath)) {
  fs.watchFile(pagamentosPath, { interval: 1000 }, () => {
    console.log('[pagamentos] Detectado update, recarregando');
    PAGAMENTOS = loadPagamentos();
  });
}

// ================== HELPERS ==================
function formatDateYMD(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' });
  const [{ value: dd }, , { value: mm }, , { value: yyyy }] = fmt.formatToParts(date);
  return `${yyyy}-${mm}-${dd}`;
}
function addDays(date, days) { const d = new Date(date); d.setDate(d.getDate() + days); return d; }
function pad2(n) { return n.toString().padStart(2,'0'); }
function parseDateSmart(input) {
  const raw = (input || '').trim().toLowerCase();
  if (raw === 'hoje')  return { ok: true, value: formatDateYMD() };
  if (raw === 'ontem') return { ok: true, value: formatDateYMD(addDays(new Date(), -1)) };
  let m = raw.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) return { ok: true, value: `${m[3]}-${pad2(m[2])}-${pad2(m[1])}` };
  m = raw.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
  if (m) return { ok: true, value: `${m[1]}-${pad2(m[2])}-${pad2(m[3])}` };
  m = raw.match(/^(\d{1,2})[\/\-](\d{1,2})$/);
  if (m) { const y = new Date().getFullYear(); return { ok: false, suggest: `${y}-${pad2(m[2])}-${pad2(m[1])}` }; }
  m = raw.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2})$/);
  if (m) return { ok: false, suggest: `20${m[3]}-${pad2(m[2])}-${pad2(m[1])}` };
  return { ok: false, suggest: null };
}

function chunkButtons(items, prefix) {
  const rows = [];
  const safe = (items || []).map(s => (s ?? '').toString().trim()).filter(Boolean).slice(0, 25).map(s => s.slice(0, 80));
  for (let i = 0; i < safe.length; i += 5) {
    const row = new ActionRowBuilder();
    safe.slice(i, i + 5).forEach(label => {
      row.addComponents(new ButtonBuilder().setCustomId(`${prefix}:${label}`).setLabel(label).setStyle(ButtonStyle.Primary));
    });
    rows.push(row);
  }
  return rows;
}
function backRow(target) {
  return new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`back:${target}`).setLabel('◀️ Voltar').setStyle(ButtonStyle.Secondary));
}
function tipoMenuRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('tipo:Entrada').setLabel('Entrada 💰').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('tipo:Saída').setLabel('Saída 🧾').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('func:SaldoAtual').setLabel('Saldo Atual 💵').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('func:SaidasPorCategoria').setLabel('Saídas por Categoria 📊').setStyle(ButtonStyle.Secondary)
  );
}
function dateQuickRows(hasLastDate) {
  const r1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('date:Hoje').setLabel('Hoje').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('date:Ontem').setLabel('Ontem').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('date:Msg').setLabel('Data da mensagem').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('date:Digit').setLabel('Digitar data').setStyle(ButtonStyle.Secondary)
  );
  if (hasLastDate) {
    const r0 = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('date:Ultima').setLabel('Usar última data').setStyle(ButtonStyle.Secondary));
    return [r0, r1];
  }
  return [r1];
}

// ================== ESTADO ==================
const state = new Map(); // { tipo, entrySource, categoria, subcategoria, pagamento, lastDate, chosenDate }

// ================== HTTP helpers ==================
async function fetchOptions(url, body) {
  console.log('[FETCH] POST =>', url, 'body=', JSON.stringify(body));
  try {
    const { data } = await axios.post(url, body || {}, { timeout: 10000 });
    console.log('[FETCH] RES <=', typeof data, JSON.stringify(data));
    if (Array.isArray(data)) return Array.isArray(data[0]?.options) ? data[0].options : [];
    return Array.isArray(data?.options) ? data.options : [];
  } catch (err) {
    console.error('[FETCH] ERROR', err?.response?.status || '', typeof err?.response?.data === 'object' ? JSON.stringify(err.response.data) : (err?.response?.data || err.message));
    throw err;
  }
}
async function postJSON(url, body) {
  console.log('[POST] =>', url, 'body=', JSON.stringify(body));
  return axios.post(url, body || {}, { timeout: 10000 });
}

// ================== DISCORD ==================
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

client.once(Events.ClientReady, () => console.log(`✅ Bot online como ${client.user.tag}`));

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  const content = message.content.trim();

  if (content.toLowerCase() === LAUNCH_COMMAND.toLowerCase()) {
    state.set(message.author.id, {});
    return message.reply({ content: '📝 **Escolha o que deseja fazer:**', components: [tipoMenuRow()] });
  }
  if (content.toLowerCase() === RELOAD_COMMAND.toLowerCase()) {
    state.delete(message.author.id);
    return message.reply('🔄 Estado resetado para você.');
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton() && !interaction.isModalSubmit()) return;

  // ---------------- BOTÕES ----------------
  if (interaction.isButton()) {
    const [stage, ...rest] = interaction.customId.split(':');
    const value = rest.join(':');
    const userId = interaction.user.id;
    const ctx = state.get(userId) || {};

 // -------- Consultas diretas (Saldo / Saídas por Categoria) --------
if (stage === 'func') {
  const action = value === 'SaldoAtual' ? 'saldo_atual' : 'saidas_por_categoria';
  try {
    const { data } = await axios.post(N8N_SAIDA_URL, {
      action,
      userId: interaction.user.id,
      username: interaction.user.username
    }, { timeout: 10000 });

    // só responde se vier algum texto; senão, não manda nada
    const text =
      data?.message || data?.content || data?.text ||
      (Array.isArray(data) && data[0]?.message) || '';

    if (text) {
      // se quiser que apareça público, tire o 'ephemeral: true'
      return interaction.reply({ content: text, ephemeral: true });
    } else {
      // apenas confirma o clique sem criar mensagem
      return interaction.deferUpdate();
    }
  } catch (e) {
    console.error('[FUNC ERROR]', e?.response?.status, e?.response?.data || e.message);
    // opcional: mostre erro, ou também sufoque
    return interaction.reply({ content: '❌ Erro ao consultar no n8n.', ephemeral: true });
  }
}


    // Voltar
    if (stage === 'back') {
      if (value === 'main' || value === 'tipo') {
        state.set(userId, {});
        return interaction.update({ content: '📝 **Escolha o que deseja fazer:**', components: [tipoMenuRow()] });
      }
      if (value === 'cat') {
        ctx.subcategoria = undefined; ctx.pagamento = undefined;
        state.set(userId, ctx);
        try {
          const categorias = await fetchOptions(N8N_SAIDA_URL, { cmd: 'saida' });
          return interaction.update({ content: '🧾 **Saída** selecionada. Agora escolha a *categoria*:', components: [...chunkButtons(categorias, 'cat'), backRow('tipo')] });
        } catch { return interaction.update({ content: '❌ Erro ao buscar categorias.', components: [backRow('tipo')] }); }
      }
      if (value === 'entr') {
        // voltar para a lista de ENTRADAS (primeiro webhook)
        state.set(userId, ctx);
        try {
          const entradas = await fetchOptions(N8N_SAIDA_URL, { action: 'entradas' });
          return interaction.update({ content: '💼 **Entrada** selecionada. Agora escolha a *origem*:', components: [...chunkButtons(entradas, 'entr'), backRow('tipo')] });
        } catch { return interaction.update({ content: '❌ Erro ao buscar entradas.', components: [backRow('tipo')] }); }
      }
    }

    // Tipo (Entrada / Saída)
    if (stage === 'tipo') {
      ctx.tipo = value;
      ctx.entrySource = ctx.categoria = ctx.subcategoria = ctx.pagamento = undefined;
      state.set(userId, ctx);

      if (value === 'Entrada') {
        // ENTRADAS pelo 1º webhook: { action: 'entradas' }
        try {
          const entradas = await fetchOptions(N8N_SAIDA_URL, { action: 'entradas' });
          return interaction.update({ content: '💼 **Entrada** selecionada. Agora escolha a *origem*:', components: [...chunkButtons(entradas, 'entr'), backRow('tipo')] });
        } catch { return interaction.update({ content: '❌ Erro ao buscar entradas.', components: [backRow('tipo')] }); }
      } else {
        // SAÍDAS (categorias) continuam no 1º webhook com { cmd:'saida' }
        try {
          const categorias = await fetchOptions(N8N_SAIDA_URL, { cmd: 'saida' });
          return interaction.update({ content: '🧾 **Saída** selecionada. Agora escolha a *categoria*:', components: [...chunkButtons(categorias, 'cat'), backRow('tipo')] });
        } catch { return interaction.update({ content: '❌ Erro ao buscar categorias.', components: [backRow('tipo')] }); }
      }
    }

    // Entrada → origem → (sem pagamento) → seletor de data
    if (stage === 'entr') {
      ctx.entrySource = value;
      state.set(userId, ctx);
      const hasLast = !!ctx.lastDate;
      return interaction.update({
        content: `📥 **Origem:** ${value}. Agora escolha a data do lançamento:`,
        components: [...dateQuickRows(hasLast), backRow('entr')]
      });
    }

    // Saída → categoria (pode ter sub)
    if (stage === 'cat') {
      ctx.categoria = value; ctx.subcategoria = undefined;
      state.set(userId, ctx);
      try {
        const subs = await fetchOptions(N8N_NEXT_URL, { step: 'subcats', categoria: value });
        if (!subs.length) {
          const formas = PAGAMENTOS;
          if (!formas.length) return interaction.update({ content: '⚠️ Nenhuma forma de pagamento em config/pagamentos.json', components: [backRow('cat')] });
          return interaction.update({ content: `📑 **Categoria:** ${value}. Agora escolha *forma de pagamento*:`, components: [...chunkButtons(formas, 'pay'), backRow('cat')] });
        }
        return interaction.update({ content: `📑 **Categoria:** ${value}. Agora escolha a *subcategoria*:`, components: [...chunkButtons(subs, 'sub'), backRow('cat')] });
      } catch { return interaction.update({ content: '❌ Erro ao buscar subcategorias.', components: [backRow('cat')] }); }
    }

    // Saída → subcategoria → pagamentos
    if (stage === 'sub') {
      ctx.subcategoria = value;
      state.set(userId, ctx);
      const formas = PAGAMENTOS;
      if (!formas.length) return interaction.update({ content: '⚠️ Nenhuma forma de pagamento em config/pagamentos.json', components: [backRow('cat')] });
      return interaction.update({ content: `💳 **Subcategoria:** ${value}. Agora escolha *forma de pagamento*:`, components: [...chunkButtons(formas, 'pay'), backRow('cat')] });
    }

    // Saída → forma de pagamento → seletor de data
    if (stage === 'pay') {
      ctx.pagamento = value;
      state.set(userId, ctx);
      const hasLast = !!ctx.lastDate;
      return interaction.update({ content: '🗓️ **Escolha a data do lançamento:**', components: [...dateQuickRows(hasLast), backRow(ctx.tipo === 'Entrada' ? 'entr' : 'cat')] });
    }

    // Atalhos de data (Entrada e Saída compartilham)
    if (stage === 'date') {
      if (value === 'Digit') {
        const modal = new ModalBuilder().setCustomId('lancamentoModal').setTitle('Data e Valor');
        const inputData  = new TextInputBuilder().setCustomId('date').setLabel('Data (AAAA-MM-DD, "hoje"/"ontem")').setStyle(TextInputStyle.Short).setPlaceholder('ex: 2025-08-09').setRequired(true);
        const inputValor = new TextInputBuilder().setCustomId('valor').setLabel('Valor (somente números)').setStyle(TextInputStyle.Short).setPlaceholder('ex: 250').setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(inputData), new ActionRowBuilder().addComponents(inputValor));
        return interaction.showModal(modal);
      }

      let chosen = null;
      if (value === 'Hoje') chosen = formatDateYMD();
      if (value === 'Ontem') chosen = formatDateYMD(addDays(new Date(), -1));
      if (value === 'Ultima' && ctx.lastDate) chosen = ctx.lastDate;
      if (value === 'Msg') chosen = formatDateYMD(interaction.createdAt);

      if (chosen) {
        ctx.chosenDate = chosen;
        state.set(userId, ctx);
        const modal = new ModalBuilder().setCustomId('valorModal').setTitle(`Valor para ${chosen}`);
        const inputValor = new TextInputBuilder().setCustomId('valor').setLabel('Valor (somente números)').setStyle(TextInputStyle.Short).setPlaceholder('ex: 250').setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(inputValor));
        return interaction.showModal(modal);
      }
    }
  }

  // ---------------- MODAIS ----------------
  if (interaction.isModalSubmit()) {
    const userId = interaction.user.id;
    const ctx = state.get(userId) || {};

    // Modal: data + valor digitados
 if (interaction.customId === 'lancamentoModal') {
  // responda já!
  await interaction.deferReply({ ephemeral: true });

  const rawDate = interaction.fields.getTextInputValue('date');
  let valor = interaction.fields.getTextInputValue('valor').trim().replace(',', '.');

  const parsed = parseDateSmart(rawDate);
  if (!parsed.ok) {
    if (parsed.suggest) {
      await interaction.editReply(`❓ Não entendi a data **"${rawDate}"**. Você quis dizer **${parsed.suggest}**?`);
      return;
    } else {
      await interaction.editReply('❌ Data inválida. Use **AAAA-MM-DD** ou "hoje"/"ontem".');
      return;
    }
  }

  const dataNorm = parsed.value;
  const userId = interaction.user.id;
  const username = interaction.user.username;
  const ctx = state.get(userId) || {};
  ctx.lastDate = dataNorm;
  state.set(userId, ctx);

  const payload = {
    tipo: ctx.tipo,
    data: dataNorm,
    valor,
    userId,
    username,
  };
  if (ctx.tipo === 'Entrada') payload.origem = ctx.entrySource;
  else { payload.categoria = ctx.categoria; payload.subcategoria = ctx.subcategoria; payload.pagamento = ctx.pagamento; }

  try {
    const url = ctx.tipo === 'Entrada' ? N8N_SAVE_ENTRADAS_URL : N8N_SAVE_URL;
    await axios.post(url, payload, { timeout: 15000 });
    await interaction.editReply('✅ Lançamento registrado!');
  } catch (e) {
    console.error('SAVE ERROR:', e?.response?.status, e?.response?.data || e.message);
    await interaction.editReply('❌ Falha ao enviar pro n8n.');
  } finally {
    state.delete(userId);
  }
}


    // Modal: só valor (data escolhida por botão)
  if (interaction.customId === 'valorModal') {
  await interaction.deferReply({ ephemeral: true });

  let valor = interaction.fields.getTextInputValue('valor').trim().replace(',', '.');

  const userId = interaction.user.id;
  const username = interaction.user.username;
  const ctx = state.get(userId) || {};
  const dataNorm = ctx.chosenDate || ctx.lastDate || formatDateYMD();

  const payload = {
    tipo: ctx.tipo,
    data: dataNorm,
    valor,
    userId,
    username,
  };
  if (ctx.tipo === 'Entrada') payload.origem = ctx.entrySource;
  else { payload.categoria = ctx.categoria; payload.subcategoria = ctx.subcategoria; payload.pagamento = ctx.pagamento; }

  try {
    const url = ctx.tipo === 'Entrada' ? N8N_SAVE_ENTRADAS_URL : N8N_SAVE_URL;
    await axios.post(url, payload, { timeout: 15000 });
    await interaction.editReply(`✅ Lançamento registrado para **${dataNorm}**!`);
  } catch (e) {
    console.error('SAVE ERROR:', e?.response?.status, e?.response?.data || e.message);
    await interaction.editReply('❌ Falha ao enviar pro n8n.');
  } finally {
    state.delete(userId);
  }
}


    // Correção de data sugerida (botões)
    if (interaction.customId.startsWith('datefix:')) {
      const [, action, value] = interaction.customId.split(':'); // datefix:accept|deny:value
      if (action === 'accept') {
        const fixed = value;
        const modal = new ModalBuilder().setCustomId('valorModal').setTitle(`Valor para ${fixed}`);
        const inputValor = new TextInputBuilder().setCustomId('valor').setLabel('Valor (somente números)').setStyle(TextInputStyle.Short).setPlaceholder('ex: 250').setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(inputValor));

        const ctx2 = state.get(interaction.user.id) || {};
        ctx2.chosenDate = fixed;
        ctx2.lastDate   = fixed;
        state.set(interaction.user.id, ctx2);

        await interaction.update({ content: `🗓️ Data ajustada para **${fixed}**. Informe o valor:`, components: [] });
        return interaction.showModal(modal);
      } else {
        const modal = new ModalBuilder().setCustomId('lancamentoModal').setTitle('Data e Valor');
        const inputData  = new TextInputBuilder().setCustomId('date').setLabel('Data (AAAA-MM-DD, "hoje"/"ontem")').setStyle(TextInputStyle.Short).setPlaceholder('ex: 2025-08-09').setRequired(true);
        const inputValor = new TextInputBuilder().setCustomId('valor').setLabel('Valor (somente números)').setStyle(TextInputStyle.Short).setPlaceholder('ex: 250').setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(inputData), new ActionRowBuilder().addComponents(inputValor));
        return interaction.showModal(modal);
      }
    }
  }
});

client.login(DISCORD_TOKEN);

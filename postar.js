// robo-versao: 6 (o painel nunca troca o robô por um de versão menor)
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const BASE = __dirname;
const CONTA = process.argv[2] || process.env.CONTA || 'conta1';
const CONTA_DIR = path.join(BASE, 'contas', CONTA);

if (!fs.existsSync(CONTA_DIR)) {
  console.error(`Conta "${CONTA}" nao encontrada em contas/${CONTA}. Contas disponiveis: ${fs.readdirSync(path.join(BASE, 'contas')).join(', ')}`);
  process.exit(1);
}

const cfg = JSON.parse(fs.readFileSync(path.join(CONTA_DIR, 'config.json'), 'utf8'));
const estado = JSON.parse(fs.readFileSync(path.join(CONTA_DIR, 'estado.json'), 'utf8'));
const legendas = JSON.parse(fs.readFileSync(path.join(CONTA_DIR, 'legendas.json'), 'utf8'));
const videoUrls = JSON.parse(fs.readFileSync(path.join(CONTA_DIR, 'video_urls.json'), 'utf8'));
const pageToken = process.env.PAGE_TOKEN || fs.readFileSync(path.join(BASE, 'segredos', `${CONTA}_page_token.txt`), 'utf8').trim();
const capaFile = path.join(CONTA_DIR, 'capa_url.txt');
const capaUrl = fs.existsSync(capaFile) ? fs.readFileSync(capaFile, 'utf8').trim() : '';

const GRAPH = 'https://graph.facebook.com/v21.0';

// Avisos (issues) no idioma escolhido no painel: config.json "idioma" = "pt" | "en".
const TXT = {
  pt: {
    acabou: ['Acabaram os vídeos', 'Todos os vídeos da fila já foram postados. Envie mais vídeos pelo painel.'],
    falha: ['Falha ao postar', (n, m) => `video_${n} falhou: ${m}`],
    bio: [l => `Trocar a bio do Instagram (lote ${l})`, (l, leg) => `Nova legenda do lote ${l}:\n\n${leg}`],
    acabando: ['Vídeos acabando', 'Faltam 12 vídeos pra postar. Envie mais vídeos pelo painel.'],
    erro: 'Erro na automação',
  },
  en: {
    acabou: ['Out of videos', 'All videos in the queue have been posted. Upload more videos in the panel.'],
    falha: ['Post failed', (n, m) => `video_${n} failed: ${m}`],
    bio: [l => `Update your Instagram bio (batch ${l})`, (l, leg) => `New caption for batch ${l}:\n\n${leg}`],
    acabando: ['Running out of videos', '12 videos left to post. Upload more videos in the panel.'],
    erro: 'Automation error',
  },
};
const T = TXT[cfg.idioma] || TXT.pt;
const LOG_FILE = path.join(BASE, 'postar.log');
const NA_NUVEM = process.env.GITHUB_ACTIONS === 'true';

function log(msg) {
  const line = `[${new Date().toISOString()}] [${CONTA}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (e) { /* sistema de arquivos read-only em alguns runners */ }
}

async function avisarViaIssue(titulo, mensagem) {
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  if (!repo || !token) { log('Sem GITHUB_REPOSITORY/GITHUB_TOKEN para abrir issue.'); return; }
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' };
  const title = `[${CONTA}] ${titulo}`;
  // Fila vazia roda a cada horário: sem isso viraria um e-mail a cada 30 min.
  const abertas = await fetch(`https://api.github.com/repos/${repo}/issues?state=open&per_page=100`, { headers });
  if (abertas.ok && (await abertas.json()).some(i => i.title === title)) { log(`Aviso "${title}" já está aberto.`); return; }
  const res = await fetch(`https://api.github.com/repos/${repo}/issues`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ title, body: mensagem }),
  });
  if (!res.ok) log(`Falha ao criar issue: ${res.status} ${await res.text()}`);
}

function avisar(titulo, mensagem) {
  if (NA_NUVEM) {
    avisarViaIssue(titulo, mensagem).catch(e => log(`Falha ao avisar via issue: ${e.message}`));
    return;
  }
  try {
    const script = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show('${mensagem.replace(/'/g, "''")}', '${`[${CONTA}] ${titulo}`.replace(/'/g, "''")}')`;
    execSync(`powershell -NoProfile -Command "${script}"`, { stdio: 'ignore' });
  } catch (e) {
    log(`Falha ao mostrar aviso: ${e.message}`);
  }
  try { fs.writeFileSync(path.join(BASE, `AVISO_${CONTA}_${Date.now()}.txt`), `${titulo}\n\n${mensagem}`); } catch (e) { /* ignore */ }
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function criarContainer(videoUrl, legenda) {
  const params = new URLSearchParams({
    media_type: 'REELS',
    video_url: videoUrl,
    caption: legenda,
    access_token: pageToken,
  });
  if (capaUrl) params.set('cover_url', capaUrl);
  const res = await fetch(`${GRAPH}/${cfg.ig_user_id}/media?${params.toString()}`, { method: 'POST' });
  const data = await res.json();
  if (data.error) throw new Error(JSON.stringify(data.error));
  return data.id;
}

async function esperarProcessamento(containerId) {
  for (let i = 0; i < 30; i++) {
    const res = await fetch(`${GRAPH}/${containerId}?fields=status_code&access_token=${pageToken}`);
    const data = await res.json();
    if (data.error) throw new Error(JSON.stringify(data.error));
    if (data.status_code === 'FINISHED') return true;
    if (data.status_code === 'ERROR') throw new Error('Processamento falhou no lado da Meta');
    await sleep(10000);
  }
  throw new Error('Tempo de processamento excedido');
}

async function publicar(containerId) {
  const params = new URLSearchParams({ creation_id: containerId, access_token: pageToken });
  const res = await fetch(`${GRAPH}/${cfg.ig_user_id}/media_publish?${params.toString()}`, { method: 'POST' });
  const data = await res.json();
  if (data.error) throw new Error(JSON.stringify(data.error));
  return data.id;
}

// A Meta às vezes devolve erro no media_publish ("Fatal", "Media ID is not available",
// "unexpected error") mas publica mesmo assim. Sem conferir, o próximo horário postava o
// mesmo vídeo de novo. O container vira PUBLISHED quando o post saiu.
async function foiPublicado(containerId, inicio) {
  for (let i = 0; i < 4; i++) {
    await sleep(15000);
    try {
      const res = await fetch(`${GRAPH}/${containerId}?fields=status_code&access_token=${pageToken}`);
      const data = await res.json();
      if (data.status_code === 'PUBLISHED') return true;
      if (!data.error) continue;
    } catch (e) { /* rede: tenta pelo feed abaixo */ }
    // Container ilegível: olha se apareceu post novo no perfil depois que a tentativa começou.
    try {
      const res = await fetch(`${GRAPH}/${cfg.ig_user_id}/media?fields=id,timestamp&limit=1&access_token=${pageToken}`);
      const ultimo = (await res.json()).data?.[0];
      if (ultimo && new Date(ultimo.timestamp).getTime() >= inicio - 60000) return true;
    } catch (e) { /* tenta de novo */ }
  }
  return false;
}

function salvarEstado() {
  fs.writeFileSync(path.join(CONTA_DIR, 'estado.json'), JSON.stringify(estado, null, 2));
}

// Posta o próximo vídeo da fila. Retorna false quando não deu (fila vazia, sem URL ou falha).
async function postarUm() {
  if (estado.proximo_video > estado.video_maximo) {
    log('Nenhum vídeo restante para postar.');
    avisar(T.acabou[0], T.acabou[1]);
    return false;
  }

  const num = estado.proximo_video;
  const videoUrl = videoUrls[String(num)];
  if (!videoUrl) {
    log(`video_${num} não tem URL no Cloudinary ainda. Abortando.`);
    return false;
  }

  const legendaObj = legendas.length ? legendas[(estado.lote_atual - 1) % legendas.length] : { legenda: '' };
  log(`Postando video_${num} (lote ${estado.lote_atual}, post ${estado.posts_no_lote_atual + 1}/${estado.tamanho_lote})`);

  let containerId = null;
  const inicio = Date.now();
  try {
    containerId = await criarContainer(videoUrl, legendaObj.legenda);
    await esperarProcessamento(containerId);
    const mediaId = await publicar(containerId);
    log(`OK - video_${num} publicado. media_id=${mediaId}`);
  } catch (e) {
    if (containerId && await foiPublicado(containerId, inicio)) {
      log(`OK - video_${num} publicado (a Meta respondeu erro, mas o post saiu: ${e.message})`);
    } else {
      log(`FALHOU video_${num}: ${e.message}`);
      avisar(T.falha[0], T.falha[1](num, e.message));
      return false;
    }
  }

  estado.proximo_video += 1;
  estado.posts_no_lote_atual += 1;

  if (estado.posts_no_lote_atual >= estado.tamanho_lote) {
    estado.posts_no_lote_atual = 0;
    estado.lote_atual += 1;
    if (legendas.length > 1) {
      const novaLegendaObj = legendas[(estado.lote_atual - 1) % legendas.length];
      log(`Legenda trocou para o lote ${estado.lote_atual}. Atualize a bio.`);
      avisar(T.bio[0](estado.lote_atual), T.bio[1](estado.lote_atual, novaLegendaObj.legenda));
    }
  }

  const restantes = estado.video_maximo - estado.proximo_video + 1;
  if (restantes === 12) {
    log('Faltam 12 vídeos. Avisando.');
    avisar(T.acabando[0], T.acabando[1]);
  }

  salvarEstado();
  return true;
}

// ------------------------------------------------------------------ métricas e respostas
// Rodam depois do post, a cada disparo. Erro aqui nunca atrapalha a postagem.

async function graphGet(caminho, params = {}) {
  const q = new URLSearchParams({ ...params, access_token: pageToken });
  const res = await fetch(`${GRAPH}/${caminho}${caminho.includes('?') ? '&' : '?'}${q}`);
  const data = await res.json();
  if (data.error) { const e = new Error(data.error.message); e.code = data.error.code; throw e; }
  return data;
}
// 10/200 = token sem a permissão (gerado antes das permissões novas do passo 4).
const semPermissao = (e) => e.code === 10 || e.code === 200 || /permission/i.test(e.message);
const lerJSON = (nome, def) => { try { return JSON.parse(fs.readFileSync(path.join(CONTA_DIR, nome), 'utf8')); } catch { return def; } };
const gravarJSON = (nome, obj) => fs.writeFileSync(path.join(CONTA_DIR, nome), JSON.stringify(obj, null, 2) + '\n');

// metricas.json: o painel monta os gráficos do Início com isso.
async function atualizarMetricas() {
  const antes = lerJSON('metricas.json', {});
  const perfil = await graphGet(cfg.ig_user_id, { fields: 'followers_count,media_count' });
  const campos = 'id,timestamp,permalink,like_count,comments_count';
  let midias = [], erro = null;
  try {
    // views só vem com instagram_manage_insights
    const r = await graphGet(`${cfg.ig_user_id}/media`, { fields: `${campos},insights.metric(views)`, limit: '30' });
    midias = r.data || [];
  } catch (e) {
    if (!semPermissao(e) && e.code !== 100) throw e;
    erro = 'sem_insights';
    midias = (await graphGet(`${cfg.ig_user_id}/media`, { fields: campos, limit: '30' })).data || [];
  }
  const hoje = new Date().toISOString().slice(0, 10);
  const historico = { ...(antes.historico || {}), [hoje]: perfil.followers_count };
  const dias = Object.keys(historico).sort().slice(-90);
  gravarJSON('metricas.json', {
    atualizado: new Date().toISOString(),
    seguidores: perfil.followers_count ?? null,
    total_posts: perfil.media_count ?? null,
    erro,
    midias: midias.map((m) => ({
      id: m.id, data: m.timestamp, link: m.permalink,
      views: m.insights?.data?.find((i) => i.name === 'views')?.values?.[0]?.value ?? null,
      likes: m.like_count ?? null, comentarios: m.comments_count ?? null,
    })),
    historico: Object.fromEntries(dias.map((d) => [d, historico[d]])),
  });
}

// Resposta automática: config.json "resposta_auto" = { texto, antigos, desde }.
// Várias mensagens separadas por linha em branco: o robô sorteia uma (texto
// idêntico em massa é o que o Instagram mais trata como spam).
// Ritmo de gente, não de robô: resposta rápida em massa leva "bloqueio de ação" do Instagram.
const RESPOSTAS_POR_RODADA = 15;
const RESPOSTAS_POR_DIA = 200;
const ESPERA_MIN = 20000, ESPERA_MAX = 45000; // sorteada entre uma resposta e outra
const REVARRER_DIAS = 3; // depois de varrer tudo, recomeça pra pegar comentário novo em post antigo

async function responderComentarios() {
  const ra = cfg.resposta_auto;
  const opcoes = String(ra?.texto || '').split(/\n\s*\n/).map((t) => t.trim()).filter(Boolean);
  if (!opcoes.length) return;
  // comentarios.json = resumo pequeno (o painel lê); respondidos.json = ids já respondidos
  const st = lerJSON('comentarios.json', {});
  const feitos = new Set(lerJSON('respondidos.json', []));
  const eu = String(cfg.ig_username || '').toLowerCase();
  const desde = ra.antigos ? 0 : Date.parse(ra.desde || 0) || 0;
  let enviados = 0;
  const dia = new Date().toISOString().slice(0, 10);
  if (st.dia !== dia) { st.dia = dia; st.hoje = 0; }
  const limite = Math.min(RESPOSTAS_POR_RODADA, RESPOSTAS_POR_DIA - st.hoje);
  if (limite <= 0) return; // cota do dia cheia: continua amanhã

  const responderMidia = async (midiaId) => {
    let url = `${midiaId}/comments`, params = { fields: 'id,username,timestamp,replies{username}', limit: '50' };
    while (url && enviados < limite) {
      const r = await graphGet(url, params);
      for (const c of r.data || []) {
        if (enviados >= limite) return false;
        if (feitos.has(c.id) || String(c.username || '').toLowerCase() === eu) continue;
        if (Date.parse(c.timestamp) < desde) continue;
        if ((c.replies?.data || []).some((x) => String(x.username || '').toLowerCase() === eu)) { feitos.add(c.id); continue; }
        const msg = opcoes[Math.floor(Math.random() * opcoes.length)];
        const res = await fetch(`${GRAPH}/${c.id}/replies?${new URLSearchParams({ message: msg, access_token: pageToken })}`, { method: 'POST' });
        const data = await res.json();
        if (data.error) {
          if (data.error.code === 10 || data.error.code === 200) { const e = new Error(data.error.message); e.code = data.error.code; throw e; }
          feitos.add(c.id); // comentário apagado/restrito: não insiste
          continue;
        }
        feitos.add(c.id); enviados++;
        if (enviados < limite) await sleep(ESPERA_MIN + Math.random() * (ESPERA_MAX - ESPERA_MIN));
      }
      const prox = r.paging?.cursors?.after;
      if (!r.paging?.next || !prox) return true;
      url = `${midiaId}/comments`; params = { ...params, after: prox };
    }
    return enviados < limite;
  };

  try {
    // 1) posts mais novos: comentários recentes primeiro
    const novos = await graphGet(`${cfg.ig_user_id}/media`, { fields: 'id,comments_count', limit: '25' });
    for (const m of novos.data || []) {
      if (m.comments_count && !(await responderMidia(m.id))) break;
    }
    // 2) varredura dos posts antigos, 25 por rodada, continuando de onde parou
    if (ra.antigos && enviados < limite) {
      const v = st.varredura || {};
      if (v.fim && Date.now() - Date.parse(v.fim) > REVARRER_DIAS * 86400000) { delete v.fim; delete v.depois; }
      if (!v.fim) {
        const pagina = await graphGet(`${cfg.ig_user_id}/media`, { fields: 'id,comments_count', limit: '25', ...(v.depois ? { after: v.depois } : {}) });
        let completa = true;
        for (const m of pagina.data || []) {
          if (m.comments_count && !(await responderMidia(m.id))) { completa = false; break; }
        }
        if (completa) {
          v.posts_varridos = (v.posts_varridos || 0) + (pagina.data || []).length;
          if (pagina.paging?.next && pagina.paging?.cursors?.after) v.depois = pagina.paging.cursors.after;
          else { v.fim = new Date().toISOString(); delete v.depois; }
        }
      }
      st.varredura = v;
    }
    st.erro = null;
  } catch (e) {
    st.erro = semPermissao(e) ? 'sem_permissao' : e.message;
  }
  fs.writeFileSync(path.join(CONTA_DIR, 'respondidos.json'), JSON.stringify([...feitos].slice(-30000)) + '\n');
  st.total = (st.total || 0) + enviados;
  st.hoje += enviados;
  st.atualizado = new Date().toISOString();
  gravarJSON('comentarios.json', st);
  if (enviados) log(`Respondi ${enviados} comentário(s).`);
}

// Postagem em massa: config.json "posts_por_vez" (ex.: 10 às 20h). O botão de teste do painel
// manda QUANTIDADE=1. O primeiro erro encerra a rodada; o resto fica pro próximo horário.
async function main() {
  const quantidade = Math.max(1, Math.min(50, Number(process.env.QUANTIDADE) || Number(cfg.posts_por_vez) || 1));
  if (quantidade > 1) log(`Rodada em massa: até ${quantidade} vídeos.`);
  for (let i = 0; i < quantidade; i++) {
    if (i > 0) {
      if (estado.proximo_video > estado.video_maximo) { log('Fila acabou no meio da rodada.'); break; }
      await sleep(20000); // respiro entre posts seguidos
    }
    if (!(await postarUm())) break;
  }
  await atualizarMetricas().catch((e) => log(`Métricas não atualizaram: ${e.message}`));
  await responderComentarios().catch((e) => log(`Respostas automáticas falharam: ${e.message}`));
}

main().catch(e => {
  log(`ERRO GERAL: ${e.message}`);
  avisar(T.erro, e.message);
});

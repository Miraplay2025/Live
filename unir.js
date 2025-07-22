const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const util = require('util');
const exec = util.promisify(require('child_process').exec);

const keyFile = path.join(os.homedir(), '.config', 'rclone', 'rclone.conf');
const input = JSON.parse(fs.readFileSync('input.json', 'utf-8'));
const arquivosTemporarios = [];

function registrarTemporario(caminho) {
  arquivosTemporarios.push(caminho);
}

function removerNaoSequencia(sequencia) {
  console.log('\n🧹 Removendo arquivos NÃO incluídos na sequência de transmissão...');
  for (const arq of arquivosTemporarios) {
    if (!sequencia.includes(arq) && fs.existsSync(arq)) {
      try {
        fs.unlinkSync(arq);
        console.log(`🗑️ Removido: ${arq}`);
      } catch (err) {
        console.error(`❌ Erro ao remover ${arq}:`, err);
      }
    } else {
      console.log(`✅ Mantido: ${arq}`);
    }
  }
}

function executarFFmpeg(args) {
  return new Promise((resolve, reject) => {
    console.log(`\n🛠️ Executando FFmpeg:\nffmpeg ${args.join(' ')}`);
    const proc = spawn('ffmpeg', ['-y', ...args]);
    proc.stderr.on('data', d => process.stderr.write(d.toString()));
    proc.on('close', code => {
      if (code === 0) {
        console.log('✅ FFmpeg finalizou com sucesso');
        resolve();
      } else {
        reject(new Error(`FFmpeg falhou: ${code}`));
      }
    });
  });
}

async function baixarArquivo(remoto, destino, reencode = true) {
  return new Promise((resolve, reject) => {
    console.log(`⬇️ Baixando: ${remoto}`);
    const rclone = spawn('rclone', ['copy', `meudrive:${remoto}`, '.', '--config', keyFile]);
    rclone.stderr.on('data', d => process.stderr.write(d.toString()));
    rclone.on('close', async code => {
      if (code !== 0) return reject(new Error(`Erro ao baixar ${remoto}`));
      const base = path.basename(remoto);
      if (!fs.existsSync(base)) return reject(new Error(`Arquivo não encontrado: ${base}`));
      fs.renameSync(base, destino);
      console.log(`✅ Baixado: ${destino}`);
      if (reencode) {
        const temp = destino.replace(/(\.[^.]+)$/, '_temp$1');
        await reencodeVideo(destino, temp);
        fs.renameSync(temp, destino);
      }
      registrarTemporario(destino);
      resolve();
    });
  });
}

async function reencodeVideo(input, output) {
  await executarFFmpeg([
    '-i', input,
    '-vf', "scale=1280:720",
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-c:a', 'aac',
    output
  ]);
  registrarTemporario(output);
}

async function obterDuracao(video) {
  const { stdout } = await exec(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${video}"`);
  return parseFloat(stdout.trim());
}

function formatarMinSeg(segundos) {
  const min = Math.floor(segundos / 60);
  const seg = Math.round(segundos % 60);
  return `${min}:${seg.toString().padStart(2, '0')}`;
}

async function cortarVideo(video, inicio, duracao, destino) {
  await executarFFmpeg([
    '-i', video,
    '-ss', `${inicio}`,
    '-t', `${duracao}`,
    '-c', 'copy',
    destino
  ]);
  registrarTemporario(destino);
}

async function aplicarLogoERodape(videoEntrada, videoSaida, logo, rodape) {
  console.log(`🖼️ Aplicando logo e rodapé em: ${videoEntrada}`);

  const filtroComplexo = '[0:v][1:v]overlay=W-w-10:10:enable=between(t\\,0\\,9999)[logo];' +
                         '[logo][2:v]overlay=0:H-h:enable=between(t\\,240\\,250)[vout]';

  await executarFFmpeg([
    '-i', videoEntrada,
    '-i', logo,
    '-i', rodape,
    '-filter_complex', filtroComplexo,
    '-map', '[vout]',
    '-map', '0:a?',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-c:a', 'aac',
    videoSaida
  ]);
  registrarTemporario(videoSaida);
}

(async () => {
  try {
    console.log(`\n🎬 Iniciando processamento...\n`);

    const {
      video_principal,
      video_inicial,
      video_miraplay,
      video_final,
      videos_extras,
      logo_id,
      rodape_id,
      id,
      stream_url
    } = input;

    // Baixar imagens sem reencode
    await baixarArquivo(logo_id, 'logo.png', false);
    await baixarArquivo(rodape_id, 'rodape.png', false);

    // Baixar e processar vídeo principal
    await baixarArquivo(video_principal, 'video_principal.mp4');
    const duracaoPrincipal = await obterDuracao('video_principal.mp4');
    const metade = duracaoPrincipal / 2;

    await cortarVideo('video_principal.mp4', 0, metade, 'parte1_bruto.mp4');
    await cortarVideo('video_principal.mp4', metade, metade, 'parte2_bruto.mp4');

    await aplicarLogoERodape('parte1_bruto.mp4', 'parte1.mp4', 'logo.png', 'rodape.png');
    await aplicarLogoERodape('parte2_bruto.mp4', 'parte2.mp4', 'logo.png', 'rodape.png');

    const arquivosSequencia = [];

    async function adicionarArquivo(nome, idRemoto) {
      await baixarArquivo(idRemoto, nome);
      arquivosSequencia.push(nome);
    }

    if (video_inicial) await adicionarArquivo('video_inicial.mp4', video_inicial);
    if (video_miraplay) await adicionarArquivo('miraplay.mp4', video_miraplay);
    if (video_final) await adicionarArquivo('video_final.mp4', video_final);

    for (let i = 0; i < videos_extras.length; i++) {
      const nome = `video_extra${i + 1}.mp4`;
      await adicionarArquivo(nome, videos_extras[i]);
    }

    // Montar sequência final (ajuste conforme o que foi realmente baixado)
    const sequencia = [
      'parte1.mp4',
      'video_inicial.mp4',
      'miraplay.mp4',
      ...arquivosSequencia,
      'video_inicial.mp4',
      'parte2.mp4',
      'video_final.mp4'
    ].filter(f => fs.existsSync(f));

    const linhas = [];
    console.log('\n📃 Lista da transmissão com durações (formato mm:ss):');
    for (const nome of sequencia) {
      const dur = await obterDuracao(nome);
      const tempoFormatado = formatarMinSeg(dur);
      linhas.push(`file '${nome}'  # duração: ${tempoFormatado}`);
      console.log(`📼 ${nome.padEnd(20)} - ${tempoFormatado}`);
    }

    fs.writeFileSync('sequencia_da_transmissao.txt', linhas.join('\n'));
    fs.writeFileSync('stream_info.json', JSON.stringify({ id, stream_url }, null, 2));

    console.log(`\n✅ Arquivos gerados:`);
    console.log('📄 stream_info.json');
    console.log('📄 sequencia_da_transmissao.txt');
    console.log(`\n🚀 Pronto para transmitir em:\n🌐 ${stream_url}`);

    // Remover arquivos NÃO na sequência (inclui logo.png e rodape.png)
    removerNaoSequencia(sequencia);

  } catch (erro) {
    console.error('❌ Erro:', erro);
    limparTemporarios();
    process.exit(1);
  }
})();

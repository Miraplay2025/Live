const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const keyFile = path.join(os.homedir(), '.config', 'rclone', 'rclone.conf');
const input = JSON.parse(fs.readFileSync('input.json', 'utf-8'));

const artefatosDir = path.resolve('artefatos/video_final');
fs.mkdirSync(artefatosDir, { recursive: true });

const arquivosTemporarios = [];

function registrarTemporario(caminho) {
  arquivosTemporarios.push(caminho);
}

function limparTemporarios() {
  console.log('\n🧹 Limpando arquivos temporários...');
  for (const arq of arquivosTemporarios) {
    if (fs.existsSync(arq)) {
      try {
        fs.unlinkSync(arq);
        console.log(`🗑️ Removido: ${arq}`);
      } catch (e) {
        console.warn(`⚠️ Falha ao remover: ${arq}`);
      }
    }
  }
}

function executarFFmpeg(args) {
  return new Promise((resolve, reject) => {
    console.log(`⚙️ Executando FFmpeg: ffmpeg ${args.join(' ')}`);
    const ffmpeg = spawn('ffmpeg', ['-y', ...args]);
    ffmpeg.stdout.on('data', d => process.stdout.write(d.toString()));
    ffmpeg.stderr.on('data', d => process.stderr.write(d.toString()));
    ffmpeg.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`❌ FFmpeg falhou com código ${code}`));
    });
  });
}

function obterDuracao(video) {
  return new Promise((resolve, reject) => {
    const ffprobe = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      video
    ]);
    let output = '';
    ffprobe.stdout.on('data', chunk => output += chunk.toString());
    ffprobe.on('close', code => {
      if (code === 0) resolve(parseFloat(output.trim()));
      else reject(new Error('❌ ffprobe falhou'));
    });
  });
}

function baixarArquivo(remoto, destino, reencode = true) {
  return new Promise((resolve, reject) => {
    console.log(`⬇️ Baixando: ${remoto}`);
    const rclone = spawn('rclone', ['copy', `meudrive:${remoto}`, '.', '--config', keyFile]);
    rclone.stderr.on('data', d => process.stderr.write(d.toString()));
    rclone.on('close', async code => {
      if (code !== 0) return reject(new Error(`Erro ao baixar ${remoto}`));
      const base = path.basename(remoto);
      if (!fs.existsSync(base)) return reject(new Error(`Arquivo não encontrado: ${base}`));
      fs.renameSync(base, destino);
      console.log(`✅ Baixado e renomeado: ${destino}`);
      if (reencode) {
        const temp = destino.replace(/(\.[^.]+)$/, '_temp$1');
        await reencodeVideo(destino, temp);
        fs.renameSync(temp, destino);
        console.log(`✅ Reencodado: ${destino}`);
      }
      registrarTemporario(destino);
      resolve();
    });
  });
}

async function reencodeVideo(input, output) {
  console.log(`🔄 Reencodando ${input} → ${output}`);
  await executarFFmpeg([
    '-i', input,
    '-vf', 'scale=1280:720,fps=30',
    '-r', '30',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-acodec', 'aac',
    '-b:a', '192k',
    '-ar', '44100',
    '-ac', '2',
    output
  ]);
  registrarTemporario(output);
}

async function cortarVideo(input, out1, out2, meio) {
  console.log(`✂️ Cortando vídeo ${input}...`);
  await executarFFmpeg(['-i', input, '-t', meio.toString(), '-c', 'copy', out1]);
  await executarFFmpeg(['-i', input, '-ss', meio.toString(), '-c', 'copy', out2]);
  registrarTemporario(out1);
  registrarTemporario(out2);
}

/**
 * Aplica logo e rodapé com animação de entrada e saída no intervalo especificado
 * O rodapé inicia como uma linha vertical no centro (largura 10px), cresce em altura,
 * depois se expande horizontalmente para largura total. Na saída, a animação é invertida.
 * 
 * @param {string} entrada - arquivo de vídeo de entrada (parte cortada)
 * @param {string} saida - arquivo de vídeo de saída (editado)
 * @param {number} offsetSegundos - tempo em segundos do início do vídeo cortado em relação ao original
 */
async function aplicarLogoERodapeAnimado(entrada, saida, offsetSegundos) {
  const rodapeInicioOriginal = 240; // 4 minutos
  const rodapeFimOriginal = 300;    // 5 minutos
  const rodapeDuracao = rodapeFimOriginal - rodapeInicioOriginal;

  // Ajusta tempo para o vídeo cortado
  const tempoInicioRelativo = rodapeInicioOriginal - offsetSegundos;
  const tempoFimRelativo = rodapeFimOriginal - offsetSegundos;

  // Se rodapé não aparece nesta parte, aplica só logo sem rodapé
  if (tempoFimRelativo <= 0 || tempoInicioRelativo >= await obterDuracao(entrada)) {
    console.log(`⚠️ Rodapé fora do intervalo da parte "${entrada}", aplicando só logo.`);
    const filtroLogo = `[1:v]scale=-1:120[logo]; [0:v][logo]overlay=W-w-1:15[outv]`;
    const argsLogo = [
      '-i', entrada,
      '-i', 'logo.png',
      '-filter_complex', filtroLogo,
      '-map', '[outv]',
      '-map', '0:a?',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '23',
      '-acodec', 'aac',
      '-b:a', '192k',
      '-ar', '44100',
      '-ac', '2',
      '-r', '30',
      saida
    ];
    await executarFFmpeg(argsLogo);
    registrarTemporario(saida);
    return;
  }

  // Clampa tempos para dentro do vídeo cortado
  const inicioExibicao = Math.max(tempoInicioRelativo, 0);
  const fimExibicao = Math.min(tempoFimRelativo, await obterDuracao(entrada));

  console.log(`🖼️ Aplicando rodapé animado em "${entrada}"`);
  console.log(`⏰ Rodapé visível entre ${inicioExibicao.toFixed(2)}s e ${fimExibicao.toFixed(2)}s`);

  // Define os tempos para animação
  const duracaoEntradaVertical = 2;  // tempo da linha crescer verticalmente (s)
  const inicioExpandirHorizontal = inicioExibicao + duracaoEntradaVertical; // começa expandir horizontalmente
  const duracaoExpandirHorizontal = 2; // duração da expansão horizontal
  const fimExpandirHorizontal = inicioExpandirHorizontal + duracaoExpandirHorizontal;

  const duracaoSaidaHorizontal = 2; // duração retração horizontal na saída
  const inicioRetrairHorizontal = fimExibicao - duracaoSaidaHorizontal;
  const fimSairVertical = fimExibicao;

  // O filtro escala animado para rodapé
  // escala largura:
  // - entrada: 10px (linha vertical)
  // - após 2s cresce altura linear
  // - depois expande largura para 1280px
  // saída: retrai largura para 10px, depois altura para 0 (sai para baixo)
  const filtro = `
    [1:v]format=rgba,
    scale='
      if(lt(t,${inicioExibicao}),
        0,
        if(lt(t,${inicioExibicao + duracaoEntradaVertical}),
          10,
          if(lt(t,${fimExpandirHorizontal}),
            (t-${inicioExpandirHorizontal})/${duracaoExpandirHorizontal}*iw,
            if(lt(t,${inicioRetrairHorizontal}),
              iw,
              if(lt(t,${fimSairVertical}),
                iw-(t-${inicioRetrairHorizontal})/${duracaoSaidaHorizontal}*(iw-10),
                0
              )
            )
          )
        )
      )
    ':
    '
      if(lt(t,${inicioExibicao}),
        0,
        if(lt(t,${inicioExibicao + duracaoEntradaVertical}),
          (t-${inicioExibicao})/${duracaoEntradaVertical}*ih/2,
          if(lt(t,${inicioRetrairHorizontal}),
            ih/2,
            if(lt(t,${fimSairVertical}),
              ih/2-(t-${inicioRetrairHorizontal})/${duracaoSaidaHorizontal}*(ih/2),
              0
            )
          )
        )
      )
    '
    [rodape_anim];
    
    [0:v][rodape_anim]overlay=x='
      if(lt(t,${fimExpandirHorizontal}),
        (W-10)/2,
        0
      )':
    y=H-h
    [outv]
  `.replace(/\s+/g, ' ');

  const args = [
    '-i', entrada,
    '-i', 'logo.png',
    '-i', 'rodape.png',
    '-filter_complex', filtro,
    '-map', '[outv]',
    '-map', '0:a?',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-acodec', 'aac',
    '-b:a', '192k',
    '-ar', '44100',
    '-ac', '2',
    '-r', '30',
    saida
  ];

  await executarFFmpeg(args);
  registrarTemporario(saida);
}

// === EXECUÇÃO PRINCIPAL ===
(async () => {
  try {
    console.log('🚀 Iniciando preparação da live...');

    await baixarArquivo(input.video_principal, 'video_principal.mp4');
    await baixarArquivo(input.logo_id, 'logo.png', false);
    await baixarArquivo(input.rodape_id, 'rodape.png', false);

    if (input.video_inicial) await baixarArquivo(input.video_inicial, 'video_inicial.mp4');
    if (input.video_miraplay) await baixarArquivo(input.video_miraplay, 'video_miraplay.mp4');
    if (input.video_final) await baixarArquivo(input.video_final, 'video_final.mp4');

    const extras = [];
    for (let i = 0; i < input.videos_extras.length; i++) {
      const nome = `extra${i + 1}.mp4`;
      await baixarArquivo(input.videos_extras[i], nome);
      extras.push(nome);
    }

    const duracaoPrincipal = await obterDuracao('video_principal.mp4');
    const meio = duracaoPrincipal / 2;
    await cortarVideo('video_principal.mp4', 'parte1.mp4', 'parte2.mp4', meio);

    // Aplicar logo e rodapé animado nas partes, passando offset relativo do corte
    await aplicarLogoERodapeAnimado('parte1.mp4', 'parte1_editada.mp4', 0);
    await aplicarLogoERodapeAnimado('parte2.mp4', 'parte2_editada.mp4', meio);

    const sequencia = [
      'parte1_editada.mp4',
      'video_inicial.mp4',
      'video_miraplay.mp4',
      ...extras,
      'video_inicial.mp4',
      'parte2_editada.mp4',
      'video_final.mp4'
    ].filter(v => fs.existsSync(v));

    const tsList = [];

    console.log('\n📦 Iniciando geração dos arquivos .ts para transmissão...');
    for (const mp4 of sequencia) {
      const tsName = path.basename(mp4).replace(/\.mp4$/, '.ts');
      const tsFullPath = path.join(artefatosDir, tsName);

      console.log(`🎞️ Gerando .ts: ${mp4} → ${tsFullPath}`);
      await executarFFmpeg([
        '-i', mp4,
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '23',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-ar', '44100',
        '-ac', '2',
        '-bsf:v', 'h264_mp4toannexb',
        '-f', 'mpegts',
        tsFullPath
      ]);

      tsList.push(tsFullPath);
    }

    const tsPathsJson = path.join(artefatosDir, 'ts_paths.json');
    const streamInfoJson = path.join(artefatosDir, 'stream_info.json');

    fs.writeFileSync(tsPathsJson, JSON.stringify(tsList, null, 2));
    fs.writeFileSync(streamInfoJson, JSON.stringify({
      id: input.id,
      stream_url: input.stream_url
    }, null, 2));

    console.log('\n✅ Preparação concluída.');
    console.log(`📄 Arquivos gerados em: ${artefatosDir}`);
    console.log(`🧾 ts_paths.json e stream_info.json criados com sucesso.`);

  } catch (erro) {
    console.error('\n❌ Erro durante o processo:', erro.message);
    process.exit(1);
  } finally {
    limparTemporarios();
  }
})();

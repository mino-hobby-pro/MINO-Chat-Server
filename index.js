const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.static('public'));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const PORT = process.env.PORT || 3000;

/* -------------------------
   シンプルなオセロ（リバーシ）ロジック
   ------------------------- */
function createInitialBoard() {
  const board = Array.from({ length: 8 }, () => Array(8).fill(null));
  board[3][3] = 'W'; board[3][4] = 'B';
  board[4][3] = 'B'; board[4][4] = 'W';
  return board;
}

const DIRS = [
  [-1,-1],[-1,0],[-1,1],
  [0,-1],       [0,1],
  [1,-1],[1,0],[1,1]
];

function inBounds(r,c){ return r>=0 && r<8 && c>=0 && c<8; }

function getOpponent(color){ return color === 'B' ? 'W' : 'B'; }

function validMoves(board, color){
  const moves = [];
  for(let r=0;r<8;r++){
    for(let c=0;c<8;c++){
      if(board[r][c] !== null) continue;
      if(canFlip(board, r, c, color)) moves.push([r,c]);
    }
  }
  return moves;
}

function canFlip(board, r, c, color){
  const opp = getOpponent(color);
  for(const [dr,dc] of DIRS){
    let rr = r+dr, cc = c+dc;
    let foundOpp = false;
    while(inBounds(rr,cc) && board[rr][cc] === opp){
      foundOpp = true;
      rr += dr; cc += dc;
    }
    if(foundOpp && inBounds(rr,cc) && board[rr][cc] === color) return true;
  }
  return false;
}

function applyMove(board, r, c, color){
  if(!canFlip(board, r, c, color)) return false;
  board[r][c] = color;
  const opp = getOpponent(color);
  for(const [dr,dc] of DIRS){
    let rr = r+dr, cc = c+dc;
    const toFlip = [];
    while(inBounds(rr,cc) && board[rr][cc] === opp){
      toFlip.push([rr,cc]);
      rr += dr; cc += dc;
    }
    if(toFlip.length && inBounds(rr,cc) && board[rr][cc] === color){
      for(const [fr,fc] of toFlip) board[fr][fc] = color;
    }
  }
  return true;
}

function countPieces(board){
  let b=0,w=0;
  for(let r=0;r<8;r++) for(let c=0;c<8;c++){
    if(board[r][c] === 'B') b++;
    if(board[r][c] === 'W') w++;
  }
  return { B: b, W: w };
}

/* -------------------------
   ゲームルーム管理（メモリ）
   room = {
     id, players: [socketId,...], colors: {socketId:'B'|'W'}, board, turnColor, status
   }
   ------------------------- */
const games = new Map();

function createGame(roomId, hostSocketId){
  const game = {
    id: roomId,
    players: [hostSocketId],
    colors: { [hostSocketId]: 'B' },
    board: createInitialBoard(),
    turnColor: 'B',
    status: 'waiting' // waiting, playing, finished
  };
  games.set(roomId, game);
  return game;
}

function joinGame(roomId, socketId){
  const game = games.get(roomId);
  if(!game) return null;
  if(game.players.length >= 2) return null;
  game.players.push(socketId);
  game.colors[socketId] = 'W';
  game.status = 'playing';
  return game;
}

/* -------------------------
   Socket.IO イベント
   ------------------------- */
io.on('connection', (socket) => {
  console.log('connect', socket.id);

  socket.on('create_game', (roomId, cb) => {
    if(games.has(roomId)){
      cb && cb({ ok:false, error:'room_exists' });
      return;
    }
    const game = createGame(roomId, socket.id);
    socket.join(roomId);
    cb && cb({ ok:true, game });
    io.to(roomId).emit('game_update', game);
  });

  socket.on('join_game', (roomId, cb) => {
    const game = games.get(roomId);
    if(!game){
      cb && cb({ ok:false, error:'no_such_room' });
      return;
    }
    if(game.players.includes(socket.id)){
      cb && cb({ ok:false, error:'already_in' });
      return;
    }
    const joined = joinGame(roomId, socket.id);
    if(!joined){
      cb && cb({ ok:false, error:'full' });
      return;
    }
    socket.join(roomId);
    cb && cb({ ok:true, game:joined });
    io.to(roomId).emit('game_update', joined);
  });

  socket.on('leave_game', (roomId) => {
    const game = games.get(roomId);
    if(!game) return;
    game.players = game.players.filter(id => id !== socket.id);
    delete game.colors[socket.id];
    socket.leave(roomId);
    if(game.players.length === 0) games.delete(roomId);
    else {
      game.status = 'waiting';
      io.to(roomId).emit('game_update', game);
    }
  });

  socket.on('move', ({ roomId, r, c }, cb) => {
    const game = games.get(roomId);
    if(!game){ cb && cb({ ok:false, error:'no_game' }); return; }
    const color = game.colors[socket.id];
    if(!color){ cb && cb({ ok:false, error:'not_in_game' }); return; }
    if(game.turnColor !== color){ cb && cb({ ok:false, error:'not_your_turn' }); return; }
    const ok = applyMove(game.board, r, c, color);
    if(!ok){ cb && cb({ ok:false, error:'invalid_move' }); return; }

    // 次の手番を決める（相手に有効手がなければパス）
    const opp = getOpponent(color);
    const oppMoves = validMoves(game.board, opp);
    if(oppMoves.length > 0) game.turnColor = opp;
    else {
      const myMoves = validMoves(game.board, color);
      if(myMoves.length > 0) game.turnColor = color;
      else {
        // ゲーム終了
        game.status = 'finished';
      }
    }

    const score = countPieces(game.board);
    io.to(roomId).emit('game_update', { ...game, score });
    cb && cb({ ok:true, game });
  });

  socket.on('chat', ({ roomId, name, message }) => {
    const payload = { from: name || '匿名', message, ts: Date.now() };
    io.to(roomId).emit('chat_message', payload);
  });

  socket.on('disconnect', () => {
    console.log('disconnect', socket.id);
    // 簡易: 参加しているゲームから削除
    for(const [id, game] of games.entries()){
      if(game.players.includes(socket.id)){
        game.players = game.players.filter(id => id !== socket.id);
        delete game.colors[socket.id];
        io.to(game.id).emit('game_update', game);
        if(game.players.length === 0) games.delete(id);
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});

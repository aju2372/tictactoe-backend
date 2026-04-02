const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const rooms = {};

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function checkWin(board) {
  const lines = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
  for (const [a,b,c] of lines) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) return { winner: board[a], line: [a,b,c] };
  }
  return null;
}

io.on('connection', (socket) => {
  console.log('connected:', socket.id);

  socket.on('create_room', ({ playerName }) => {
    let code;
    do { code = generateRoomCode(); } while (rooms[code]);

    rooms[code] = {
      code,
      players: [{ id: socket.id, name: playerName, symbol: 'X' }],
      board: Array(9).fill(null),
      current: 'X',
      scores: { X: 0, O: 0 },
      gameOver: false,
      lastWinner: null
    };

    socket.join(code);
    socket.roomCode = code;
    socket.emit('room_created', { code });
    console.log(`Room ${code} created by ${playerName}`);
  });

  socket.on('join_room', ({ code, playerName }) => {
    const upperCode = code.toUpperCase();
    const room = rooms[upperCode];

    if (!room) return socket.emit('error', { message: 'Room not found. Check the code and try again.' });
    if (room.players.length >= 2) return socket.emit('error', { message: 'Room is full. Game already in progress.' });

    room.players.push({ id: socket.id, name: playerName, symbol: 'O' });
    socket.join(upperCode);
    socket.roomCode = upperCode;

    const p1 = room.players[0];
    const p2 = room.players[1];

    io.to(p1.id).emit('game_start', {
      symbol: 'X',
      myName: p1.name,
      opponentName: p2.name,
      board: room.board,
      current: room.current,
      scores: room.scores
    });

    io.to(p2.id).emit('game_start', {
      symbol: 'O',
      myName: p2.name,
      opponentName: p1.name,
      board: room.board,
      current: room.current,
      scores: room.scores
    });

    console.log(`${playerName} joined room ${upperCode}`);
  });

  socket.on('make_move', ({ index }) => {
    const code = socket.roomCode;
    const room = rooms[code];
    if (!room || room.gameOver) return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player || player.symbol !== room.current) return;
    if (room.board[index]) return;

    room.board[index] = room.current;

    const result = checkWin(room.board);
    if (result) {
      room.gameOver = true;
      room.lastWinner = result.winner;
      room.scores[result.winner]++;
      io.to(code).emit('game_update', { board: room.board, current: room.current, scores: room.scores });
      io.to(code).emit('game_over', { type: 'win', winner: result.winner, line: result.line, scores: room.scores });
    } else if (room.board.every(v => v)) {
      room.gameOver = true;
      room.lastWinner = null;
      io.to(code).emit('game_update', { board: room.board, current: room.current, scores: room.scores });
      io.to(code).emit('game_over', { type: 'draw', scores: room.scores });
    } else {
      room.current = room.current === 'X' ? 'O' : 'X';
      io.to(code).emit('game_update', { board: room.board, current: room.current, scores: room.scores });
    }
  });

  socket.on('request_rematch', () => {
    const code = socket.roomCode;
    const room = rooms[code];
    if (!room) return;

    // Winner of last round gets X, loser gets O. Draw = keep same symbols.
    if (room.lastWinner) {
      const winner = room.players.find(p => p.symbol === room.lastWinner);
      const loser  = room.players.find(p => p.symbol !== room.lastWinner);
      if (winner && loser) {
        winner.symbol = 'X';
        loser.symbol  = 'O';
      }
    }

    room.board = Array(9).fill(null);
    room.current = 'X';
    room.gameOver = false;
    room.lastWinner = null;

    const px = room.players.find(p => p.symbol === 'X');
    const po = room.players.find(p => p.symbol === 'O');

    if (px && po) {
      io.to(px.id).emit('game_reset', {
        symbol: 'X',
        myName: px.name,
        opponentName: po.name,
        board: room.board,
        current: room.current,
        scores: room.scores
      });
      io.to(po.id).emit('game_reset', {
        symbol: 'O',
        myName: po.name,
        opponentName: px.name,
        board: room.board,
        current: room.current,
        scores: room.scores
      });
    }
  });

  socket.on('disconnect', () => {
    const code = socket.roomCode;
    if (!code || !rooms[code]) return;
    io.to(code).emit('opponent_left');
    delete rooms[code];
    console.log(`Room ${code} closed`);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));

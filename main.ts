import "reflect-metadata"
import { randomInt } from "crypto";
import { Worker, parentPort, threadId } from "worker_threads";
import { Network, IncommingMsg } from "./lib/network";
import { State } from "./lib/state";
import { Receipt } from "./worker";
import {User} from './lib/states/user';
import {User as DBUser} from './db/models/user';
import { Chat, ChatRoom as DBChatRoom } from "./db/models/chat";
import { ChatRoom } from "./lib/states/chat";
import { fullfillParameters, CMD_PARAMETERS } from "./lib/util";
import { GameRoom } from "./lib/states/room";
import { AutohostManager } from "./lib/autohost";
import { BlobOptions } from "buffer";
import { IncomingMessage } from "http";

const state: State = new State();
const workers: Worker[] = [];
const network: Network = new Network(8081);
const autohostMgr: AutohostManager = new AutohostManager(['127.0.0.1, ::ffff:127.0.0.1'], {
    port: 5000
})

// clientID -> username
const clientID2username: Record<string, string> = {};
const username2clientID: Record<string, string> = {};
// seq -> clientID
const seq2respond: Record<number, string> = {};
let seqCount = 0
// this should be used as battlePort of games 
// that need to be dispatched into autohosts
let autohostLoad: {[key:string]: number} = {}

for(let i=0; i<4; i++) {
    let worker = new Worker('./worker.js');
    worker.on('online', () => {
        console.log(`Worker ${worker.threadId} online`);
    })
    worker.on('exit', (code) => {
        console.log(`worker ${worker.threadId} exited with code ${code}`);
    })
    worker.on('message', async (msg: Receipt) => {
        switch(msg.receiptOf) {
            case 'LOGIN': {
                if(msg.status) {
                    const user: DBUser = msg.payload.user;
                    const stateUser = new User(user);
                    clientID2username[seq2respond[msg.seq]] = user.username;
                    username2clientID[user.username] = seq2respond[msg.seq];

                    state.addUser(stateUser);
                    console.log(stateUser)

                    network.emit('postMessage', seq2respond[msg.seq], {
                        action: 'LOGIN',
                        seq: msg.seq,
                        state: state.dump(stateUser.username)
                    })
                } else {
                    network.emit('postMessage', seq2respond[msg.seq], {
                        action: 'NOTIFY',
                        seq: msg.seq,
                        message: msg.message,
                    })
                }

                break;
            }
            case 'JOINCHAT': {
                const chatRoom: DBChatRoom = msg.payload.chatRoom;
                if(msg.status) {
                    if(msg.payload.type === 'CREATE') {
                        const stateChatRoom = new ChatRoom(chatRoom);
                        const user = state.getUser(clientID2username[seq2respond[msg.seq]]);
                        if(user!==null) {
                            stateChatRoom.join(user);
                            // may be problematic due to race
                            user.assignChat(stateChatRoom);
                            state.assignUser(user.username, user);

                            await state.addChat(stateChatRoom);
                            console.log(stateChatRoom)

                            network.emit('postMessage', seq2respond[msg.seq], {
                                action: 'JOINCHAT',
                                seq: msg.seq,
                                state: state.dump(user.username)
                            })
                        }
                    } else if(msg.payload.type === 'JOIN') {
                        console.log('joining')
                        const stateChatRoom = state.getChat(chatRoom.roomName);
                        console.log(stateChatRoom);
                        if(stateChatRoom === null) {
                            network.emit('postMessage', seq2respond[msg.seq], {
                                action: 'NOTIFY',
                                seq: msg.seq,
                                message: 'Chat room may be dismissed',
                            })
                            break;
                        }

                        const user = state.getUser(clientID2username[seq2respond[msg.seq]]);
                        if(user !== null) {
                            stateChatRoom.join(user);
                            user.assignChat(stateChatRoom);
                            state.assignUser(user.username, user);

                            await state.assignChat(stateChatRoom.roomName, stateChatRoom);
                            console.log(stateChatRoom)
                            network.emit('postMessage', seq2respond[msg.seq], {
                                action: 'JOINCHAT',
                                seq: msg.seq,
                                state: state.dump(user.username)
                            })
                        }
                    }
                } else {
                    network.emit('postMessage', seq2respond[msg.seq], {
                        action: 'NOTIFY',
                        seq: msg.seq,
                        message: msg.message,
                    })
                }
                state.releaseChat(chatRoom.roomName);
                break;
            }
            case 'SAYCHAT': {
                console.log(msg.payload.chat);
                const chat: ChatRoom = Object.assign(new ChatRoom(msg.payload.chat), msg.payload.chat);
                const user = state.getUser(clientID2username[seq2respond[msg.seq]]);
                if(user === null) {
                    network.emit('postMessage', seq2respond[msg.seq], {
                        action: 'NOTIFY',
                        seq: msg.seq,
                        message: 'User may be dismissed',
                    })
                    break;
                }
                if(msg.status) {
                    await state.assignChat(chat.roomName, chat);
                    user.assignChat(chat);
                    console.log(chat)
                    console.log(chat.lastMessage)

                    for(const member of chat.members) {
                        network.emit('postMessage', username2clientID[member], {
                            action: 'SAYCHAT',
                            seq: msg.seq,
                            state: state.dump(clientID2username[seq2respond[msg.seq]])
                        })
                    }
                } else {
                    network.emit('postMessage', seq2respond[msg.seq], {
                        action: 'NOTIFY',
                        seq: msg.seq,
                        message: msg.message,
                    })
                }
                state.releaseChat(chat.roomName);
                break;
            }
            case 'LEAVECHAT': {
                const chat: ChatRoom = Object.assign(new ChatRoom(msg.payload.chat), msg.payload.chat);
                if(msg.status) {
                    await state.assignChat(chat.roomName, chat);
                    console.log(chat)
                    
                    if(chat.empty()) {
                        await state.removeChat(chat.roomName)
                    }

                    network.emit('postMessage', seq2respond[msg.seq], {
                        action: 'LEAVECHAT',
                        seq: msg.seq,
                        state: state.dump(clientID2username[seq2respond[msg.seq]])
                    })
                } else {
                    network.emit('postMessage', seq2respond[msg.seq], {
                        action: 'NOTIFY',
                        seq: msg.seq,
                        message: msg.message,
                    })
                }
                state.releaseChat(chat.roomName);
                break;
            }
            case 'JOINGAME': {
                const game: GameRoom = Object.assign(new GameRoom(), msg.payload.game);

                console.log(game);
                console.log(typeof game)
                const user = state.getUser(clientID2username[seq2respond[msg.seq]]);
                if(user === null) {
                    network.emit('postMessage', seq2respond[msg.seq], {
                        action: 'NOTIFY',
                        seq: msg.seq,
                        message: 'User may be logged out',
                    })
                    break;
                }

                const actionType: string = msg.payload.type;

                if(msg.status) {
                    if(actionType === 'CREATE') {
                        state.addGame(game);
                        user.assignGame(game);
                        state.assignUser(user.username, user);
                        network.emit('postMessage', seq2respond[msg.seq], {
                            action: 'JOINGAME',
                            seq: msg.seq,
                            state: state.dump(clientID2username[seq2respond[msg.seq]])
                        })
                    } else if(actionType === 'JOIN') {
                        state.assignGame(game.title, game);
                        user.assignGame(game);
                        state.assignUser(user.username, user);
                        network.emit('postMessage', seq2respond[msg.seq], {
                            action: 'JOINGAME',
                            seq: msg.seq,
                            state: state.dump(clientID2username[seq2respond[msg.seq]])
                        })
                    } else {
                        console.log('unknown action type')
                        network.emit('postMessage', seq2respond[msg.seq], {
                            action: 'NOTIFY',
                            seq: msg.seq,
                            message: 'Something wrong happend: Unknown action type',
                        })
                    }
                } else {
                    network.emit('postMessage', seq2respond[msg.seq], {
                        action: 'NOTIFY',
                        seq: msg.seq,
                        message: msg.message,
                    })
                }
                state.releaseGame(game.title);
                break;
            }
            case 'SETAI': {
                const game: GameRoom = Object.assign(new GameRoom(), msg.payload.game);
                const user = state.getUser(clientID2username[seq2respond[msg.seq]]);
                if(user === null) {
                    network.emit('postMessage', seq2respond[msg.seq], {
                        action: 'NOTIFY',
                        seq: msg.seq,
                        message: 'User may be dismissed',
                    })
                    break;
                }
                console.log(game)
                if(msg.status) {
                    state.assignGame(game.title, game);
                    user.assignGame(game);

                    const members = Object.keys(game.players); 
                    for(const member of members) {
                        network.emit('postMessage', username2clientID[member], {
                            action: 'SETAI',
                            seq: msg.seq,
                            state: state.dump(member)
                        })
                    }
                } else {
                    network.emit('postMessage', seq2respond[msg.seq], {
                        action: 'NOTIFY',
                        seq: msg.seq,
                        message: msg.message,
                    })
                }
                if(game) state.releaseGame(game.title);
                break;
            }
            case 'DELAI': {
                const game: GameRoom = Object.assign(new GameRoom(), msg.payload.game);
                const user = state.getUser(clientID2username[seq2respond[msg.seq]]);
                if(user === null) {
                    network.emit('postMessage', seq2respond[msg.seq], {
                        action: 'NOTIFY',
                        seq: msg.seq,
                        message: 'User may be dismissed',
                    })
                    break;
                }
                console.log(game)
                if(msg.status) {
                    state.assignGame(game.title, game);
                    user.assignGame(game);

                    const members = Object.keys(game.players);
                    for(const member of members) {
                        network.emit('postMessage', username2clientID[member], {
                            action: 'DELAI',
                            seq: msg.seq,
                            state: state.dump(member)
                        })
                    }
                } else {
                    network.emit('postMessage', seq2respond[msg.seq], {
                        action: 'NOTIFY',
                        seq: msg.seq,
                        message: msg.message,
                    })
                }
                if(game) state.releaseGame(game.title);
                break;
            }
            case 'SETTEAM': {
                const game: GameRoom = Object.assign(new GameRoom(), msg.payload.game);
                const user = state.getUser(clientID2username[seq2respond[msg.seq]]);
                if(user === null) {
                    network.emit('postMessage', seq2respond[msg.seq], {
                        action: 'NOTIFY',
                        seq: msg.seq,
                        message: 'User may be dismissed',
                    })
                    break;
                }
                console.log(game)
                const members = Object.keys(game.players);
                if(msg.status) {
                    state.assignGame(game.title, game);
                    user.assignGame(game);
                    for(const member of members) {
                        network.emit('postMessage', username2clientID[member], {
                            action: 'SETTEAM',
                            seq: msg.seq,
                            state: state.dump(member)
                        })
                    }
                } else {
                    network.emit('postMessage', seq2respond[msg.seq], {
                        action: 'NOTIFY',
                        seq: msg.seq,
                        message: msg.message,
                    })
                }
                if(game) state.releaseGame(game.title);
                break;
            }
            case 'SETMAP': {
                const game: GameRoom = Object.assign(new GameRoom(), msg.payload.game);
                const user = state.getUser(clientID2username[seq2respond[msg.seq]]);
                if(user === null) {
                    network.emit('postMessage', seq2respond[msg.seq], {
                        action: 'NOTIFY',
                        seq: msg.seq,
                        message: 'User may be dismissed',
                    })
                    break;
                }
                console.log(game)
                const members = Object.keys(game.players);
                if(msg.status) {
                    state.assignGame(game.title, game);
                    user.assignGame(game);
                    for(const member of members) {
                        network.emit('postMessage', username2clientID[member], {
                            action: 'SETMAP',
                            seq: msg.seq,
                            state: state.dump(member)
                        })
                    }
                } else {
                    network.emit('postMessage', seq2respond[msg.seq], {
                        action: 'NOTIFY',
                        seq: msg.seq,
                        message: msg.message,
                    })
                }
                if(game) state.releaseGame(game.title);
                break;
            }
            case 'STARTGAME': {
                const game: GameRoom = Object.assign(new GameRoom(), msg.payload.game);
                const start: boolean = msg.payload.start;
                const user = state.getUser(clientID2username[seq2respond[msg.seq]]);
                if(user === null) {
                    network.emit('postMessage', seq2respond[msg.seq], {
                        action: 'NOTIFY',
                        seq: msg.seq,
                        message: 'User may be dismissed',
                    })
                    break;
                }

                if(msg.status) {
                    state.assignGame(game.title, game);
                    user.assignGame(game);

                    const members = Object.keys(game.players);
                    for(const member of members) {
                        network.emit('postMessage', username2clientID[member], {
                            action: 'STARTGAME',
                            seq: msg.seq,
                            state: state.dump(member)
                        })
                    }
                    if(start) {
                        autohostMgr.start(game.configureToStart())
                    }
                } else {
                    network.emit('postMessage', seq2respond[msg.seq], {
                        action: 'NOTIFY',
                        seq: msg.seq,
                        message: msg.message,
                    })
                }
                if(game) state.releaseGame(game.title);
                break;
            }
        }
        delete seq2respond[msg.seq];
    })

    workers.push(worker)
}

network.on('message', async (clientId: string, msg: IncommingMsg) => {
    let worker = workers[randomInt(0, workers.length)];


    console.log(`msg from ${clientId} with seq ${msg.seq}`)

    if(msg.action === 'GETSEQ') {
        network.emit('postMessage', clientId, {
            action: 'GETSEQ',
            seq: seqCount,
        })

        seqCount++;
        if(seqCount > 10000000000) seqCount = 0;

        return;
    }

    if(!(msg.action in CMD_PARAMETERS) 
        || !(fullfillParameters(msg.action as keyof typeof CMD_PARAMETERS, msg.parameters))) {
        network.emit('postMessage', clientId, {
            action: 'NOTIFY',
            seq: msg.seq,
            message: 'Invalid parameters',
        })
        return;
    }


    if(!msg.seq) {
        network.emit('postMessage', clientId, {
            action: 'NOTIFY',
            message: 'seq not found',
        });
        return
    }
    if(msg.seq in seq2respond) {
        network.emit('postMessage', clientId, {
            action: 'NOTIFY',
            message: 'seq already used',
        });
        return
    }


    // record in mem only if message have seq, right cmd and sufficient parameters
    seq2respond[msg.seq] = clientId;


    if(msg.action === 'LOGIN') {
        if(!(msg.parameters.username in username2clientID)) worker.postMessage(msg);
        else {
            network.emit('postMessage', clientId, {
                action: 'NOTIFY',
                seq: msg.seq,
                message: 'user already loggged in'
            })
            delete seq2respond[msg.seq]
        }
        return;
    }
    if(!clientID2username[clientId]) {
        network.emit('postMessage', clientId, {
            action: 'NOTIFY',
            seq: msg.seq,
            message: 'please login to access',
        })
        return
    }

    switch(msg.action) {
        case 'JOINCHAT': {
            const chat = state.getChat(msg.parameters.chatName);
            if(!(chat === null)) await state.lockChat(chat.roomName);

            msg.payload = {
                chat: chat
            }
            worker.postMessage(msg);
            break;
        }
        case 'SAYCHAT': {
            const chat = state.getChat(msg.parameters.chatName);
            if(!(chat === null)) await state.lockChat(chat.roomName);

            msg.payload = {
                chat,
                user: state.getUser(clientID2username[clientId])
            }
            worker.postMessage(msg);
            break;
        }
        case 'LEAVECHAT': {
            const chat = state.getChat(msg.parameters.chatName);
            if(!(chat === null)) await state.lockChat(chat.roomName);

            msg.payload = {
                chat: state.getChat(msg.parameters.chatName),
                user: state.getUser(clientID2username[clientId])
            }
            worker.postMessage(msg);
            break;
        }
        case 'JOINGAME': {
            const game = state.getGame(msg.parameters.gameName);
            if(!(game === null)) {
                await state.lockGame(game.title);

                msg.payload = {
                    game: game,
                    user: state.getUser(clientID2username[clientId]),
                }
            } else {
                const autohosts = Object.keys(autohostLoad);
                if(autohosts.length < 0) {
                    network.emit('postMessage', clientId, {
                        action: 'NOTIFY',
                        seq: msg.seq,
                        message: 'No autohost available',
                    })

                    delete seq2respond[msg.seq];
                    return;
                }

                // TODO: use AutohostManager to load balance
                const autohost = autohosts[randomInt(0, autohosts.length)];

                msg.payload = {
                    game: game,
                    user: state.getUser(clientID2username[clientId]),
                    autohost: autohost,
                    roomID: autohostLoad[autohost]
                }

                autohostLoad[autohost]++;
            }

            worker.postMessage(msg);
            break;
        }
        case 'SETAI': {
            const game = state.getGame(msg.parameters.gameName);
            const user = state.getUser(clientID2username[clientId]);
            
            if(game) await state.lockGame(game.title);

            msg.payload = {
                game,
                user
            }
            worker.postMessage(msg);

            break;
        }
        case 'DELAI': {
            const game = state.getGame(msg.parameters.gameName);
            const user = state.getUser(clientID2username[clientId]);

            if(game) await state.lockGame(game.title);

            msg.payload = {
                game,
                user
            }

            worker.postMessage(msg);

            break;
        }
        case 'SETTEAM': {
            const game = state.getGame(msg.parameters.gameName);
            const user = state.getUser(clientID2username[clientId]);

            if(game) await state.lockGame(game.title);

            msg.payload = {
                game,
                user
            }

            worker.postMessage(msg);

            break;
        }
        case 'SETMAP': {
            const game = state.getGame(msg.parameters.gameName);
            const user = state.getUser(clientID2username[clientId]);

            if(game) await state.lockGame(game.title);

            msg.payload = {
                game,
                user
            }

            worker.postMessage(msg);

            break;
        }
        case 'STARTGAME': {
            const user = state.getUser(clientID2username[clientId]);
            const game = user?.game

            if(game) await state.lockGame(game.title);

            msg.payload = {
                game,
                user
            }

            worker.postMessage(msg);
            break;
        }
    }
})

network.on('clean', (clientID: string) => {
    const user = state.getUser(clientID2username[clientID])
    if(user) state.garbageCollect(user)

    delete clientID2username[clientID];
    if(user) delete username2clientID[user?.username];

    // needs optimization, cur: O(n)
    for(const seq in seq2respond) {
        if(seq2respond[seq] === clientID) {
            delete seq2respond[seq];
        }
    }
})

autohostMgr.on('conn', (ws: WebSocket, req: IncomingMessage) => {
    if(req.socket.remoteAddress) autohostLoad[req.socket.remoteAddress] = 0;
})
import "reflect-metadata"
import { parentPort } from "worker_threads";
import { IncommingMsg } from "./lib/network";
import {AppDataSource} from './db/datasource';
import {User} from './db/models/user';
import { ChatRoom } from "./db/models/chat";

let dbInitialized = false;

export interface Receipt {
    receiptOf: string
    seq: number
    status: boolean
    message: string
    payload: {[key: string]: any}
}

function toParent(receipt: Receipt) {
    parentPort?.postMessage(receipt)
}

AppDataSource.initialize().then(() => {
    dbInitialized = true;
}).catch(e=> {
    console.log(e)
})


parentPort?.on('message', async (msg: IncommingMsg) => {
    if(!dbInitialized) {
        console.log("DB not initialized");
        return;
    }

    switch(msg.action) {
        case 'LOGIN': {
            const { username, password } = msg.parameters;

            let user = await AppDataSource
                .getRepository(User)
                .findOneBy({
                    username: username
                })
            
            if(user === null) {
                user = new User()
                user.username = username
                const {salt, hash} = User.saltNhash(password)
                user.salt = salt
                user.hash = hash

                await AppDataSource.manager.transaction(async (txEntityManager) => {
                    await txEntityManager.save(user)
                })

                const receipt: Receipt = {
                    receiptOf: 'LOGIN',
                    status: true,
                    seq: msg.seq,
                    message: 'register successfully',
                    payload: {
                        user: user
                    }
                }

                toParent(receipt)
            } else {
                if(user.verify(password)) {
                    const receipt: Receipt = {
                        receiptOf: 'LOGIN',
                        status: true,
                        seq: msg.seq,
                        message: 'login successfully',
                        payload: {
                            user: user
                        }
                    }

                    toParent(receipt)
                } else {
                    const receipt: Receipt = {
                        receiptOf: 'LOGIN',
                        status: false,
                        seq: msg.seq,
                        message: 'wrong password',
                        payload: {}
                    }

                    toParent(receipt)
                }
            }
        }
        case 'JOINCHAT': {
            const {chat} = msg.payload;
            const {chatName, password} = msg.parameters;
            if(chat === null) {
                const chatRoom = new ChatRoom()
                chatRoom.password = password
                chatRoom.chats = []
                chatRoom.roomName = chatName

                await AppDataSource.manager.transaction(async (txEntityManager) => {
                    await txEntityManager.save(chatRoom)
                })

                parentPort?.postMessage({
                    receiptOf: 'JOINCHAT',
                    status: true,
                    seq: msg.seq,
                    message: 'chat created',
                    payload: {
                        chatRoom,
                        type: 'CREATE'
                    } 
                })
            } else {
                if(password === chat.password) {
                    const receipt: Receipt = {
                        receiptOf: 'JOINCHAT',
                        status: true,
                        seq: msg.seq,
                        message: 'chat joined',
                        payload: {
                            chatRoom: chat,
                            type: 'JOIN'
                        }
                    }

                    toParent(receipt)
                } else {
                    const receipt: Receipt = {
                        receiptOf: 'JOINCHAT',
                        status: false,
                        seq: msg.seq,
                        message: 'wrong password',
                        payload: {}
                    }

                    toParent(receipt)
                }
            }
            break;
        }
    }
})

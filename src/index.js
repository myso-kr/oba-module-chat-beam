import _ from 'lodash';
import Promise from 'bluebird';
import Logger from 'debug';
import EventEmitter from 'events'
import URL from 'url';
import Util from 'util';
import fetchNode from 'node-fetch';
import fetchCookie from 'fetch-cookie';
import WebSocket from 'ws';

const fetch = fetchCookie(fetchNode);

const HTTP_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/56.0.2924.87 Safari/537.36';
const URL_ORIGIN = 'https://beam.pro';
const HTTP_BASE_URL = "https://beam.pro/%s";
const URL_BROADCAST_META = "https://beam.pro/api/v1/channels/%s";
const URL_BROADCAST_SOCK = "https://beam.pro/api/v1/chats/%s";

export default class Module extends EventEmitter {
    constructor(oba, options, url) {
        super();
        this.name = "oba:chat:beam";
        this.oba = oba || new EventEmitter();
        this.stdout = Logger(`${this.name}`);
        this.stderr = Logger(`${this.name}:error`);

        const uri = URL.parse(url, true, true);
        const segments = _.split(uri.pathname, '/');
        this.defaults = {
            name: this.name,
            source: url, 
            caster: {
                username: _.get(segments, 1),
                identify: _.get(segments, 1)
            }
        };
        this.options = _.merge({}, this.defaults, options);
        this.socket = new Socket(this);
    }

    connect() { this.socket.connect(); }

    disconnect() { this.socket.disconnect(); }

    async meta() {
        const resp = await fetch(Util.format(URL_BROADCAST_META, this.options.caster.username), {
            headers: {
                'User-Agent': HTTP_USER_AGENT,
                'Referer': Util.format(HTTP_BASE_URL, this.options.caster.username)
            }
        }).then((resp) => resp.json());
        return resp;
    }
    async sock(id) {
        const resp = await fetch(Util.format(URL_BROADCAST_SOCK, id), {
            headers: {
                'User-Agent': HTTP_USER_AGENT,
                'Referer': Util.format(HTTP_BASE_URL, this.options.caster.username)
            }
        }).then((resp)=>resp.json());
        return _.sample(_.get(resp, 'endpoints'));
    }
}

class Socket extends EventEmitter {
    constructor(module) {
        super();
        this.timer = null;
        this.module = module;
        this.events = [];
        this.eventsCount = 0;
        this.addEventPacketName("welcome", 'WelcomeEvent');
        this.addEventPacketName("message", 'ChatMessage');
    }
    addEventPacketName(eventName, matchPattern) {
        this.events.push({ eventName, matchPattern });
    }
    getEventPacketName(packetData) {
        return _.get(_.find(this.events, (event) => _.isEqual(event.matchPattern, packetData.event)), 'eventName');
    }

    connect() {
        if(this.native) return;
        this.native = true;
        Promise.resolve().then(async () => {
            const meta = await this.module.meta();
            const metaId = _.get(meta, 'id');
            const sock = await this.module.sock(metaId);

            const socket = this.native = new WebSocket(sock, '', { origin: URL_ORIGIN });
            const socketEmit = (data) => socket.send(JSON.stringify(data));
            socket.on('open', () => this.emit('connect'));
            socket.on('error', (e) => this.emit('error', e));
            socket.on('close', () => {
                this.native = null;
                this.emit('close');
            });
            socket.on('message', (data) => {
                const resp = JSON.parse(data);
                const eventName = this.getEventPacketName(resp);
                if (eventName) { this.emit(eventName, _.get(resp, 'data')) }
            });
            this.on('connect', () => this.module.emit('connect'));
            this.on('error', (e) => this.module.emit('error', e));
            this.on('close', () => this.module.emit('close'));

            this.on('welcome', () => socketEmit({ id: this.eventsCount++, type: 'method', method: 'auth', arguments: [metaId, null, null] }));
            this.on('message', (segments) => {
                const messages = _.get(segments, 'message.message');
                this.module.emit('message', {
                    module: this.module.defaults,
                    username: _.get(segments, 'user_name'),
                    nickname: _.get(segments, 'user_name'),
                    message: _.join(_.map(messages, (msg)=>msg.type === 'text' ? msg.text : `(${msg.text})`), ''),
                    timestamp: Date.now()
                });
            });

            this.module.on('connect', () => {
                this.timer = setTimeout(() => {
                    socketEmit({ id: this.eventsCount++, type: 'method', method: 'ping', arguments: [] });
                }, 5000)
            });
            this.module.on('close', () => clearTimeout(this.timer));
        })
        .catch((e)=>{
            if(this.native && this.native.close) {
                this.native.close();
            } else {
                this.native = null;
                this.module.emit('error', e);
                this.module.emit('close');
            }
        });
    }
    disconnect() {
        if(!this.native) return;
        this.native.close();
    }
}
import {PacketHandler} from '../packet/packet.handler';
import {Bignum} from '../utilities/bignum';
import {Stream} from './stream';
import {Constants} from '../utilities/constants';
import {Version} from '../packet/header/long.header';
import {ClientInitialPacket} from '../packet/packet/client.initial';
import {PacketParser, PacketOffset} from '../packet/packet.parser';
import {PacketFactory} from '../packet/packet.factory';
import {QTLS} from '../crypto/qtls';
import {ConnectionID, PacketNumber} from '../packet/header/base.header';
import {VersionNegotiationPacket} from '../packet/packet/version.negotiation';
import {BasePacket} from '../packet/base.packet';
import { Socket, createSocket, RemoteInfo } from 'dgram';
import * as fs from 'fs';
import {EndpointType} from './type';
import {Connection, RemoteInformation} from './connection';


export class Client {
        
    private port: number;
    private hostname: string;

    private packetParser: PacketParser;
    private packetHandler: PacketHandler;

    private connection: Connection;

    constructor() {
        this.packetParser = new PacketParser();
        this.packetHandler = new PacketHandler();
    }

    public connect(hostname: string, port: number) {
        this.hostname = hostname;
        this.port = port;
        var socket = createSocket("udp4");
        socket.on('error',(err) => {this.onError(err)});
        socket.on('message',(msg, rinfo) => {this.onMessage(msg, rinfo)});
        socket.on('close',() => {this.onClose()});
        var remoteInfo: RemoteInformation = {
            address: hostname,
            port: port, 
            family: 'IPv4'
        };
        this.connection = new Connection(remoteInfo, EndpointType.Client);
        this.connection.setConnectionID(ConnectionID.randomConnectionID());
        this.connection.setFirstConnectionID(this.connection.getConnectionID());
        this.connection.setSocket(socket);
    }

    public testSend() {
        var packetNumber = PacketNumber.randomPacketNumber();
        this.connection.setPacketNumber(packetNumber);
        var version = new Version(Buffer.from(Constants.getActiveVersion(), 'hex'));
        console.log("connectionid: " + this.connection.getConnectionID().toString());
        console.log("packet number: " + packetNumber.toString());
        this.connection.addStream(new Stream(Bignum.fromNumber(0)));
        var clientInitial: ClientInitialPacket = PacketFactory.createClientInitialPacket(this.connection);
        this.connection.getSocket().send(clientInitial.toBuffer(this.connection), this.port, this.hostname);
    }

    public getPort(): number {
        return this.port;
    }
    
    public getHostname(): string {
        return this.hostname;
    }

    private onMessage(msg: Buffer, rinfo: RemoteInfo): any {
        console.log("on message");
        try {
            var packetOffset: PacketOffset = this.packetParser.parse(msg, EndpointType.Server, this.connection);
            this.packetHandler.handle(this.connection, packetOffset.packet);
            
        }catch(err) {
            // packet not parseable yet.
            console.log("parse error: " + err.message);
            return;
        }
    }

    private onError(error: Error): any {
        console.log("error");
    }

    private onClose(): any {
        console.log("close");
    }

}
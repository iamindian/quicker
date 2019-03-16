import { BasePacket, PacketType } from '../packet/base.packet';
import { Bignum } from '../types/bignum';
import { Alarm, AlarmEvent } from '../types/alarm';
import { AckFrame } from '../frame/ack';
import { EventEmitter } from 'events';
import { Connection, ConnectionEvent } from '../quicker/connection';
import { VerboseLogging } from '../utilities/logging/verbose.logging';
import { RTTMeasurement } from './rtt.measurement';
import { EncryptionLevel } from '../crypto/crypto.context';

// SentPackets type:
// Key is the value of the packet number toString
// Value is of type SentPacket
type SentPackets = { [key: string]: SentPacket };

// Type SentPacket with properties used by LossDetection according to 'QUIC Loss Detection and Congestion Control' draft
// sentBytes can be accessed by using the toBuffer method of packet followed by the byteLength property of the buffer object
export interface SentPacket {
    // An object of type BasePacket
    packet: BasePacket,
    // Milliseconds sinds epoch
    time: number, // time at which this packet is sent locally, used to calculate RTT
    // Does the packet contain frames that are retransmittable
    isRetransmittable: boolean
};

/**
 * An enum to enumerate the three packet numberspaces. 
 */
enum kPacketNumberSpace{
    Initial = 0,
    Handshake = 1,
    ApplicationData = 2
}


export class QuicLossDetection extends EventEmitter {

    public DEBUGname = "";

    ///////////////////////////
    // Constants of interest
    ///////////////////////////

    // Maximum reordering in packets before packet threshold loss detection considers a packet lost
    public static readonly kPacketThreshold: number = 3;
    // Maximum reordering in time before time threshold loss detection considers a packet lost.  Specified as an RTT multiplier
    public static readonly kTimeThreshold: number = 9.0 / 8.0;
    // Timer granularity.  In ms
    public static readonly kGranularity : number = 50;
    // The default RTT used before an RTT sample is taken. In ms.
    public static readonly kInitialRTT: number = 100;
    //kpacketnumberspace

    ///////////////////////////
    // Variables of interest
    ///////////////////////////

    // Multi-modal alarm used for loss detection.
    private lossDetectionAlarm!: Alarm;
    // The number of times the crypto packets have been retransmitted without receiving an ack.
    private cryptoCount!: number;
    // The number of times a PTO has been sent without receiving an ack.
    private ptoCount: number;
    // The time the most recent ack-eliciting packet was sent.
    private timeOfLastSentAckElicitingPacket: number;
    // The time the most recent packet containing handshake data was sent.
    private timeOfLastSentCryptoPacket: number
    // The largest packet number acknowledged in an ACK frame.
    private largestAckedPacket: Bignum[];
    // The time at which the next packet will be considered lost based on early transmit or 
    // exceeding the reordering window in time.
    private lossTime: number[];
    // An association of packet numbers to information about them, including a number field indicating the packet number, 
    // a time field indicating the time a packet was sent, a boolean indicating whether the packet is ack only, 
    // and a bytes field indicating the packet’s size. sent_packets is ordered by packet number, 
    // and packets remain in sent_packets until acknowledged or lost.
    private sentPackets: SentPackets[];

    private ackElicitingPacketsOutstanding: number;
    private cryptoOutstanding: number;

    //TODO: change this from public
    public rttMeasurer: RTTMeasurement;

    public constructor(rttMeasurer: RTTMeasurement, connection: Connection) {
        super();
        this.lossDetectionAlarm = new Alarm();
        this.cryptoCount = 0;
        this.ptoCount = 0;
        
        this.rttMeasurer = rttMeasurer;
        
        this.timeOfLastSentAckElicitingPacket = 0;
        this.timeOfLastSentCryptoPacket = 0;
        this.largestAckedPacket = [];
        this.lossTime = [];
        this.sentPackets = [];


        for(let space of [kPacketNumberSpace.Initial,kPacketNumberSpace.Handshake, kPacketNumberSpace.ApplicationData]){
            this.largestAckedPacket.push(new Bignum(0));
            this.lossTime.push(0)
            this.sentPackets.push({})
        }

        this.ackElicitingPacketsOutstanding = 0;
        this.cryptoOutstanding = 0;
    }


    private findPacketSpaceFromPacket(packet : BasePacket){
        let type : PacketType = packet.getPacketType();
        if(type == PacketType.Handshake){
            return kPacketNumberSpace.Handshake;
        }
        else if(type == PacketType.Initial){
            return kPacketNumberSpace.Initial;
        }
        else{
            /**
             * TODO: check if doing "else" here is ok
             * the pn_spaces in the recovery-document seems to be limited to
             * handshake, inital and applications. while retry and 0/1rtt are also separate
             * (retry does not have separate number space, but does it fall under "application data"?) 
             */
            return kPacketNumberSpace.ApplicationData;
        }
    }

    private findPacketSpaceFromAckFrame(frame : AckFrame){
        let type : EncryptionLevel | undefined = frame.getCryptoLevel();
        if(type == EncryptionLevel.HANDSHAKE){
            return kPacketNumberSpace.Handshake;
        }
        else if(type == EncryptionLevel.INITIAL){
            return kPacketNumberSpace.Initial;
        }
        else{
            /**
             * TODO: check if doing "else" here is ok
             * Don't know if basing this of the encryption level is ok either.
             * the pn_spaces in the recovery-document seems to be limited to
             * handshake, inital and applications. while retry and 0/1rtt are also separate
             * (retry does not have separate number space, but does it fall under "application data"?) 
             */
            return kPacketNumberSpace.ApplicationData;
        }
    }


 

    /**
     * After any packet is sent, be it a new transmission or a rebundled transmission, the following OnPacketSent function is called
     * @param basePacket The packet that is being sent. From this packet, the packetnumber and the number of bytes sent can be derived.
     */
    public onPacketSent(basePacket: BasePacket): void {
        let space : kPacketNumberSpace = this.findPacketSpaceFromPacket(basePacket);
        var currentTime = (new Date()).getTime();
        var packetNumber = basePacket.getHeader().getPacketNumber().getValue();

        var sentPacket: SentPacket = {
            packet: basePacket,
            time: currentTime,
            isRetransmittable: basePacket.isRetransmittable()
        };
        
        //TODO add check for in_flight
        if (basePacket.isHandshake()) {
            this.cryptoOutstanding++;
            this.timeOfLastSentCryptoPacket = currentTime;
        }
        if (basePacket.isRetransmittable()) {
            this.ackElicitingPacketsOutstanding++;
            this.timeOfLastSentAckElicitingPacket = currentTime;
        }
        // this.congestionControl.onPacketSent(basePacket.toBuffer().byteLength);
        //TODO add packet sent
        this.setLossDetectionAlarm();

        let packet = this.sentPackets[space][packetNumber.toString('hex', 8)];
        if( packet !== undefined ){
            VerboseLogging.error(this.DEBUGname + " xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
            VerboseLogging.error(this.DEBUGname + " Packet was already in sentPackets buffer! cannot add twice, error!" + packetNumber.toNumber() + " -> packet type=" + packet.packet.getHeader().getPacketType());
            VerboseLogging.error(this.DEBUGname + " xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
        }
        else{
            VerboseLogging.debug(this.DEBUGname + " loss:onPacketSent : adding packet " +  packetNumber.toNumber() + ", is retransmittable=" + basePacket.isRetransmittable() );

            this.sentPackets[space][packetNumber.toString('hex', 8)] = sentPacket;
        }
    }



    private updateRtt(ackFrame: AckFrame) {
        let space : kPacketNumberSpace = this.findPacketSpaceFromAckFrame(ackFrame);
        let largestAcknowledgedPacket : SentPacket = this.sentPackets[space][ackFrame.getLargestAcknowledged().toString('hex', 8)];

         // check if we have not yet received an ACK for the largest acknowledge packet (then it would have been removed from this.sentPackets)
         // we could receive a duplicate ACK here, for which we don't want to update our RTT estimates
        if( largestAcknowledgedPacket !== undefined &&largestAcknowledgedPacket.isRetransmittable){
            this.rttMeasurer.updateRTT(ackFrame, largestAcknowledgedPacket);
        }
        else
            VerboseLogging.info(this.DEBUGname + " LossDetection:updateRtt : not actually updating RTT because largestAcknowledgedPacket was previously acknowledged in a different ACK frame or it was an ACK-only frame");

    }



    /**
     * When an ack is received, it may acknowledge 0 or more packets.
     * @param ackFrame The ack frame that is received by this endpoint
     */
    public onAckReceived(ackFrame: AckFrame): void {
        let space : kPacketNumberSpace = this.findPacketSpaceFromAckFrame(ackFrame);
        VerboseLogging.info(this.DEBUGname + " Loss:onAckReceived AckFrame is acking " + ackFrame.determineAckedPacketNumbers().map((val, idx, arr) => val.toNumber()).join(","));
        this.largestAckedPacket[space] = Bignum.max( ackFrame.getLargestAcknowledged(), this.largestAckedPacket[space]);


        this.updateRtt(ackFrame);

        // Process ECN information if present.	
        //TODO: fill this in when detecting ecn in acks is possible.
       /* if (ACK frame contains ECN information){	
            this.emit(LossDetectionEvents.ECN_ACK, ackFrame)
        }*/

        this.determineNewlyAckedPackets(ackFrame).forEach((sentPacket: BasePacket) => {
            this.onSentPacketAcked(sentPacket);
        });
        this.detectLostPackets(space);


        this.cryptoCount = 0;
        this.ptoCount = 0;

        this.setLossDetectionAlarm();
    }



    // reads the packet numbers from a received ack frame
    // those packet numbers correspond to packets we have sent, that are (probably) in this.sentPackets (could have been removed by receiving a previous ACK)
    // this method transforms the packet numbers to actual packet object references of sent packets so they can be removed from the list
    private determineNewlyAckedPackets(receivedAckFrame: AckFrame): BasePacket[] {
        var ackedPackets: BasePacket[] = [];
        var ackedPacketnumbers = receivedAckFrame.determineAckedPacketNumbers();

        ackedPacketnumbers.forEach((packetnumber: Bignum) => {
            //console.log("Loss:determineNewlyAckedPackets : looking for sent packet " + packetnumber.toNumber());
            for(let space of [kPacketNumberSpace.Initial,kPacketNumberSpace.Handshake, kPacketNumberSpace.ApplicationData]){
                let foundPacket = this.sentPackets[space][packetnumber.toString('hex', 8)];
                if (foundPacket !== undefined) {
                    //console.log("Loss:determineNewlyAckedPackets : Was found " + packetnumber.toNumber());
                    ackedPackets.push( foundPacket.packet );
                }
            }
            //else{
                //console.log("Loss:determineNewlyAckedPackets : COULD NOT FIND, WAS ACKED EARLIER? " + packetnumber.toNumber() + " // " + Object.keys(this.sentPackets).length);
                //console.log(this.sentPackets);
            //}

        });

        return ackedPackets;
    }



    /**
     * When a sent packet is ACKed by the receiver for the first time, onSentPacketAcked is called. 
     * Note that a single received ACK frame may newly acknowledge several sent packets. 
     * onSentPacketAcked must be called once for each of these newly acked packets. 
     * OnPacketAcked takes one parameter, acked_packet_number returns a list of packet numbers that are detected as lost.
     * If this is the first acknowledgement following RTO, check if the smallest newly acknowledged packet is one sent by the RTO,
     * and if so, inform congestion control of a verified RTO, similar to F-RTO [RFC5682]
     * @param sentPacket A reference to one of the sentPackets that is being acked in a received ACK frame
     */
    private onSentPacketAcked(sentPacket: BasePacket): void {

        let ackedPacketNumber: Bignum = sentPacket.getHeader().getPacketNumber().getValue();
        VerboseLogging.info(this.DEBUGname + " loss:onSentPacketAcked called for nr " + ackedPacketNumber.toNumber() + ", is retransmittable=" + sentPacket.isRetransmittable());

        // TODO: move this to the end of this function? 
        // inform ack handler so it can update internal state, congestion control so it can update bytes-in-flight etc.
        // TODO: call ackhandler and congestion control directly instead of using events? makes code flow clearer 
        if(sentPacket.isRetransmittable())
            this.emit(QuicLossDetectionEvents.PACKET_ACKED, sentPacket);
        
        this.removeFromSentPackets( this.findPacketSpaceFromPacket(sentPacket), ackedPacketNumber );
    }



    private removeFromSentPackets( space:kPacketNumberSpace, packetNumber:Bignum ){

        let packet = this.sentPackets[space][packetNumber.toString('hex', 8)];
        if( !packet ){
            VerboseLogging.error("LossDetection:removeFromSentPackets : packet not in sentPackets " + packetNumber.toString('hex', 8) + ". SHOULD NOT HAPPEN! added this because it crashes our server, no idea yet what causes it");
            return;
        }

        if (this.sentPackets[space][packetNumber.toString('hex', 8)].packet.isRetransmittable()) {
            this.ackElicitingPacketsOutstanding--;
        }
        if (this.sentPackets[space][packetNumber.toString('hex', 8)].packet.isHandshake()) {
            this.cryptoOutstanding--;
        }
        delete this.sentPackets[space][packetNumber.toString('hex', 8)];
    }


    /**
     * Returns the earliest loss_time and the packet number space it's from
     */
    private getEarliestLossTime(){
        let time : number = this.lossTime[kPacketNumberSpace.Initial];
        let space :kPacketNumberSpace = kPacketNumberSpace.Initial;

        
        for(let pnSpace of [kPacketNumberSpace.Handshake, kPacketNumberSpace.ApplicationData]){
            if(this.lossTime[pnSpace] !== 0 && (time === 0 || this.lossTime[pnSpace] < time)){
                time = this.lossTime[pnSpace];
                space = pnSpace;
            }
        }
        return [time, space];
    }



    public setLossDetectionAlarm(): void {
        // Don't arm the alarm if there are no packets with retransmittable data in flight.
        // TODO: replace retransmittablePacketsOutstanding by bytesInFlight
        if (this.ackElicitingPacketsOutstanding === 0) {
            this.lossDetectionAlarm.reset();
            VerboseLogging.info(this.DEBUGname + " LossDetection:setLossDetectionAlarm : no outstanding retransmittable packets, disabling loss alarm for now");
            return;
        }
        else
            VerboseLogging.debug(this.DEBUGname + " LossDetection:setLossDetectionAlarm : " + this.ackElicitingPacketsOutstanding + " outstanding retransmittable packets" );
        
        var alarmDuration: number;
        var time: number = this.timeOfLastSentAckElicitingPacket;
        let earliestLoss = this.getEarliestLossTime()[0];
        if (this.cryptoOutstanding !== 0) {
            // Crypto retransmission alarm.
            if (this.rttMeasurer.smoothedRtt == 0) {
                alarmDuration = QuicLossDetection.kInitialRTT * 2;
            } else {
                alarmDuration = this.rttMeasurer.smoothedRtt * 2;
            }

            alarmDuration = Math.max( alarmDuration + this.rttMeasurer.maxAckDelay, QuicLossDetection.kGranularity);
            var pw = Math.pow(2, this.cryptoCount);
            alarmDuration = alarmDuration * pw;
            time = this.timeOfLastSentCryptoPacket;
            VerboseLogging.debug(this.DEBUGname + " LossDetection:alarm: handshake mode " + alarmDuration );
        } else if (earliestLoss != 0) {
            // time threshold loss detection
            alarmDuration = earliestLoss - this.timeOfLastSentAckElicitingPacket;
            VerboseLogging.debug(this.DEBUGname + " LossDetection:alarm: early retransmit " + alarmDuration);
        } else {
            // PTO alarm
           alarmDuration = this.rttMeasurer.smoothedRtt + this.rttMeasurer.rttVar * 4 + this.rttMeasurer.maxAckDelay;
           alarmDuration = Math.max(alarmDuration, QuicLossDetection.kGranularity);
           alarmDuration = alarmDuration * Math.pow(2, this.ptoCount);
        }

        if (!this.lossDetectionAlarm.isRunning()) {
            this.lossDetectionAlarm.on(AlarmEvent.TIMEOUT, (timePassed:number) => {
                VerboseLogging.info(this.DEBUGname + " LossDetection:setLossDetectionAlarm timeout alarm fired after " + timePassed + "ms");
                this.lossDetectionAlarm.reset();
                this.onLossDetectionAlarm();
            });
            this.lossDetectionAlarm.start(alarmDuration);
        }
    }



    /**
     * QUIC uses one loss recovery alarm, which when set, can be in one of several modes. 
     * When the alarm fires, the mode determines the action to be performed.
     */
    public onLossDetectionAlarm(): void {
        let earliestLossTime = this.getEarliestLossTime()[0];
        let space = this.getEarliestLossTime()[1];

        if (this.cryptoOutstanding > 0) {
            // Handshake retransmission alarm.
            this.retransmitAllUnackedHandshakeData();
            this.cryptoCount++;
        } else if (earliestLossTime != 0) {
            // Early retransmit or Time Loss Detection
            this.detectLostPackets(space);
        } else {
            //PTO
            //this is also allowed to be one packet
            this.sendTwoPackets()
            this.ptoCount++;
        }
        this.setLossDetectionAlarm();
    }



    private detectLostPackets(space: kPacketNumberSpace): void {
        this.lossTime[space] = 0;
        var lostPackets: BasePacket[] = [];
        let lossDelay : number = QuicLossDetection.kTimeThreshold * Math.max(this.rttMeasurer.latestRtt, this.rttMeasurer.smoothedRtt);

        //packets send before this time are deemed lost
        let lostSendTime : number = (new Date()).getTime() - lossDelay;

        // packets with packet number before this are lost
        // TODO: check this for pn spaces?
        let lostPN : Bignum = this.largestAckedPacket[space].subtract(QuicLossDetection.kPacketThreshold);


        Object.keys(this.sendPackets).forEach((key:string) => {
            var unackedPacketNumber = new Bignum(Buffer.from(key, 'hex'));
            if(unackedPacketNumber > this.largestAckedPacket[space])
                return;
            
            var unacked = this.sentPackets[space][key];
            if(unacked.time <= lostSendTime || unacked.packet.getHeader().getPacketNumber().getValue().lessThanOrEqual(lostPN)){
                this.removeFromSentPackets(space, unackedPacketNumber);
                //TODO: check for
                //if(unacked.inFlight){
                lostPackets.push(unacked.packet);
                //}
            }
            else{ 
                if(this.lossTime[space] == 0){
                    this.lossTime[space] = unacked.time + lossDelay;
                }
                else{
                    this.lossTime[space] = Math.min(this.lossTime[space], unacked.time + lossDelay);
                }
            }
            
        });

        // Inform the congestion controller of lost packets and
        // let it decide whether to retransmit immediately.
        if (lostPackets.length > 0) {
            this.emit(QuicLossDetectionEvents.PACKETS_LOST, lostPackets);
            lostPackets.forEach((packet: BasePacket) => {
                var sentPacket = this.sentPackets[space][packet.getHeader().getPacketNumber().getValue().toString('hex', 8)];
                if (sentPacket !== undefined && sentPacket.packet.isHandshake()) {
                    this.cryptoOutstanding--;
                }
            });
        }
    }



    private sendOnePacket(): void {
        this.sendPackets(1);
    }

    private sendTwoPackets(): void {
        this.sendPackets(2);
    }

    private sendPackets(amount: number) {
        /**
         * TODO: what if there are no packets left to send?
         * rfc also specifies to first send new data, before sending unacked data
         * (but also allows some other strategy)
         * since PTO uses this function (via sendTwoPackets())
         * a probe might not happen
         * this situation might present itself when there is 1 packet unacked
         * PTO happens (and in current implementation sendTwoPackets() is called)
         * one probe gets sent with the unacked data but a second one can not be found
         * (test to make sure this is true)
         */
        var sendCount = 0;
        for(let space of [kPacketNumberSpace.Initial,kPacketNumberSpace.Handshake, kPacketNumberSpace.ApplicationData]){
            var i = 0;
            var keys = Object.keys(this.sentPackets[space]);
            while (keys.length > i) {
                if (this.sentPackets[space][keys[i]].packet.isRetransmittable()) {
                    
                    this.retransmitPacket(this.sentPackets[space][keys[i]]);
                    this.removeFromSentPackets(space, this.sentPackets[space][keys[i]].packet.getHeader().getPacketNumber().getValue() );
                    //delete this.sentPackets[keys[i]];
                    
                    sendCount++;
                    if (sendCount === amount) {
                        return;
                    }
                }
                i++;
            }
        }
    }

    private retransmitAllUnackedHandshakeData(): void {
        for(let space of [kPacketNumberSpace.Initial,kPacketNumberSpace.Handshake, kPacketNumberSpace.ApplicationData]){
            Object.keys(this.sentPackets[space]).forEach((key: string) => {
                if (this.sentPackets[space][key].packet.isHandshake()) {
                    //delete this.sentPackets[key];
                    this.retransmitPacket(this.sentPackets[space][key]);
                    this.removeFromSentPackets(space, this.sentPackets[space][key].packet.getHeader().getPacketNumber().getValue() );
                }
            });
        }
    }

    private retransmitPacket(sentPacket: SentPacket) {
        if (sentPacket.packet.isRetransmittable()) {
            this.emit(QuicLossDetectionEvents.RETRANSMIT_PACKET, sentPacket.packet);
        }
    }

    public reset() {
        this.lossDetectionAlarm.reset();
        this.sentPackets = [];
        for(let space of [kPacketNumberSpace.Initial,kPacketNumberSpace.Handshake, kPacketNumberSpace.ApplicationData]){
            this.sentPackets.push({});
        }
    }
}

export enum QuicLossDetectionEvents {
    RETRANSMISSION_TIMEOUT_VERIFIED = "ld-retransmission-timeout-verified",
    PACKETS_LOST = "ld-packets-lost",
    PACKET_ACKED = "ld-packet-acked",
    RETRANSMIT_PACKET = "ld-retransmit-packet",
    ECN_ACK = "ld-ECN-in-ACK",
    PTO_PROBE_SEND = "ld-PTO-PROBE"
}

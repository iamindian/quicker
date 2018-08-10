import { Client } from "./quicker/client";
import { HttpHelper } from "./http/http0.9/http.helper";
import { QuicStream } from "./quicker/quic.stream";
import { QuickerEvent } from "./quicker/quicker.event";
import { PacketLogging } from "./utilities/logging/packet.logging";
import { HandshakeState } from "./crypto/qtls";
import { Constants } from "./utilities/constants";



let host = process.argv[2] || "127.0.0.1";
let port = process.argv[3] || 4433;
let version = process.argv[4] || Constants.getActiveVersion(); // pass "deadbeef" to force version negotiation

if (isNaN(Number(port))) {
    console.log("port must be a number: node ./mainclient.js 127.0.0.1 4433 deadbeef");
    process.exit(-1);
}

Constants.LOG_FILE_NAME = "client.log";

console.log("QUICker client connecting to " + host + ":" + port);

var httpHelper = new HttpHelper();
for (var i = 0; i < 1; i++) {
    var client = Client.connect(host, Number(port), { version: version });
    client.on(QuickerEvent.CLIENT_CONNECTED, () => {

        var quicStream: QuicStream = client.request(httpHelper.createRequest("index.html"));
        var bufferedData = Buffer.alloc(0);

        quicStream.on(QuickerEvent.STREAM_DATA_AVAILABLE, (data: Buffer) => {
            //bufferedData = Buffer.concat([bufferedData, data]);
        });

        quicStream.on(QuickerEvent.STREAM_END, () => {
            //console.log(bufferedData.toString('utf8'));
            client.close();
        });


	
        setTimeout(() => {
            for( let i = 0; i < 10; ++i)
            	console.log("///////////////////////////////////////////////////////////////////////////////");
            var client2 = Client.connect(host, Number(port), {
                session: client.getSession(),
                transportparameters: client.getTransportParameters()
            }, httpHelper.createRequest("index.html"));
            client2.on(QuickerEvent.CLIENT_CONNECTED, () => {
                //
            });
            client2.on(QuickerEvent.CONNECTION_CLOSE, () => {
        		console.log("--------------------------------------------------------------------------------------------------");
				console.log("Server closed connection2 " + client2.getConnection().getSrcConnectionID().toString() );
        		PacketLogging.getInstance().logPacketStats( client2.getConnection().getSrcConnectionID().toString() );

				console.log("=> EXPECTED: TX 1 INITIAL, 2 0-RTT, 1 HANDSHAKE, 3-7 Protected1RTT, then RX 1 INITIAL, 1 HANDSHAKE, 5-7 Protected1RTT\n");

                console.log("Connection2 allowed early data: " + client2.getConnection().getQuicTLS().isEarlyDataAllowed() + " == true" );
                console.log("Connection2 was re-used:        " + client2.getConnection().getQuicTLS().isSessionReused() + " == true");
                console.log("Connection2 handshake state:    " + HandshakeState[client2.getConnection().getQuicTLS().getHandshakeState()] + " == COMPLETED" );

				process.exit(0);
            });
        }, 3000);
	
	
    });

    client.on(QuickerEvent.ERROR, (error: Error) => { 
        console.log("error");
        console.log(error.message);
        console.log(error.stack);
    });

    client.on(QuickerEvent.CONNECTION_CLOSE, () => {
        console.log("--------------------------------------------------------------------------------------------------");
		console.log("Server closed connection " + client.getConnection().getSrcConnectionID().toString() );
        PacketLogging.getInstance().logPacketStats( client.getConnection().getSrcConnectionID().toString() );

		console.log("=> EXPECTED: TX 1 INITIAL, 1 HANDSHAKE, 3-7 Protected1RTT, then RX 1 INITIAL, 2 HANDSHAKE, 5-7 Protected1RTT\n");

        // note: isEarlyDataAllowed() always return true, even if the session wasn't resumed (at least if the server allows early data on resumed connections). This does NOT mean early data was used ont he connection
        console.log("Connection1 allowed early data: " + client.getConnection().getQuicTLS().isEarlyDataAllowed() + " == true" );
        console.log("Connection1 was re-used:        " + client.getConnection().getQuicTLS().isSessionReused() + " == false");
        console.log("Connection1 handshake state:    " + HandshakeState[client.getConnection().getQuicTLS().getHandshakeState()] + " == COMPLETED" );

        //process.exit(0);
    });
}

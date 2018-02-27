import {Connection} from './connection';
import {EndpointType} from './endpoint.type';
import {TransportParameterType} from '../crypto/transport.parameters';
import {Bignum} from './bignum';
import { EventEmitter } from 'events';
import { logMethod } from './../utilities/decorators/log.decorator';

export abstract class FlowControlledObject extends EventEmitter {

	private localOffset!: Bignum;
	private remoteOffset!: Bignum;
	private localMaxData!: Bignum;
    private remoteMaxData!: Bignum;

    public constructor() {
		super();
        //
    }

    protected init(connection: Connection) {
		this.localOffset = Bignum.fromNumber(0);
		this.remoteOffset = Bignum.fromNumber(0);
    }

    public getLocalOffset(): Bignum {
		return this.localOffset;
	}

	public getRemoteOffset(): Bignum {
		return this.remoteOffset;
	}

	public addLocalOffset(offset: number): void;
	public addLocalOffset(offset: Bignum): void;
	public addLocalOffset(offset: any): void {
		this.localOffset = this.localOffset.add(offset);
	}

	public addRemoteOffset(offset: number): void;
	public addRemoteOffset(offset: Bignum): void;
	public addRemoteOffset(offset: any) {
		this.remoteOffset = this.remoteOffset.add(offset);
	}

	public setRemoteMaxData(maxData: number): void;
	public setRemoteMaxData(maxData: Bignum): void;
	public setRemoteMaxData(maxData: any): void {
		if (maxData instanceof Bignum) {
			this.remoteMaxData = maxData;
			return;
		}
		this.remoteMaxData = Bignum.fromNumber(maxData);
	}

	public getRemoteMaxData(): Bignum {
		return this.remoteMaxData;
	}

	public setLocalMaxData(maxData: number): void;
	public setLocalMaxData(maxData: Bignum): void;
	public setLocalMaxData(maxData: any): void {
		if (maxData instanceof Bignum) {
			this.localMaxData = maxData;
			return;
		}
		this.localMaxData = Bignum.fromNumber(maxData);
	}

	public getLocalMaxData(): Bignum {
		return this.localMaxData;
	}

    public isLocalLimitExceeded(added: any): boolean {
		var temp = this.localOffset.add(added);
		return this.isLimitExeeded(this.localMaxData, temp);
	}

    public isRemoteLimitExceeded(added: any): boolean {
		var temp = this.remoteOffset.add(added);
		return this.isLimitExeeded(this.remoteMaxData, temp);
	}

	private isLimitExeeded(maxData: Bignum, offset: Bignum): boolean {
		return offset.greaterThan(maxData);
	}

    public isLocalLimitAlmostExceeded(added: any): boolean {
		var temp = this.localOffset.add(added);
		return this.isLimitAlmostExceeded(this.localMaxData, temp);
	}

    public isRemoteLimitAlmostExceeded(added: any): boolean {
		var temp = this.remoteOffset.add(added);
		return this.isLimitAlmostExceeded(this.remoteMaxData, temp);
	}

	private isLimitAlmostExceeded(maxData: Bignum, offset: Bignum): boolean {
		var perc = maxData.divide(5);
		var temp = offset.add(perc);
		return temp.greaterThanOrEqual(maxData);
	}

	/**
	 * Used for version negotiation packet received
	 */
	protected resetOffsets(): void {
		this.localOffset = Bignum.fromNumber(0);
		this.remoteOffset = Bignum.fromNumber(0);
	}

}
import { API, Nullable, AccessoryPlugin, Service, CharacteristicValue, Logging, AccessoryConfig } from 'homebridge';

import axios from 'axios';
import bonjour from 'bonjour';

import { MANUFACTURER } from './settings';

interface AirGradientData {
  boot: number;
  wifi: number;
  serialno: string;
  rco2: number;
  pm01: number;
  pm02: number;
  pm10: number;
  pm003Count: number;
  atmp: number;
  rhum: number;
  tvocIndex: number;
  tvoc_raw: number;
  noxIndex: number;
  nox_raw: number;
  ledMode: string;
  firmwareVersion: string;
  fwMode: string;
}

class AirQualitySensor implements AccessoryPlugin {
  private readonly infoService: Service;
  private readonly airQualityService: Service;
  private readonly temperatureService: Service;
  private readonly name: string;
  private deviceUrl?: string;
  private firmwareVersion?: string;
  private isConnected: boolean;

  constructor(
    public log: Logging,
    public config: AccessoryConfig,
    public api: API,
  ) {
    this.name = config.name;

    this.infoService = new api.hap.Service.AccessoryInformation();
    this.infoService.setCharacteristic(this.api.hap.Characteristic.Manufacturer, MANUFACTURER);
    this.infoService.setCharacteristic(this.api.hap.Characteristic.SerialNumber, this.config.serialNumber);

    // Initialize services
    this.airQualityService = new api.hap.Service.AirQualitySensor(this.name);

    this.airQualityService.addCharacteristic(this.api.hap.Characteristic.PM2_5Density);
    this.airQualityService.addCharacteristic(this.api.hap.Characteristic.CarbonDioxideLevel);

    this.temperatureService = new api.hap.Service.TemperatureSensor(`${this.name} Temperature`);

    this.isConnected = false;
    this.addHandlers();
    this.discoverDevice();
  }

  discoverDevice(): void {
    this.log.debug('Starting device discovery using Bonjour');
    const browser = bonjour().find({ type: 'airgradient' });
    browser.on('up', service => {
      if (service.name.includes(`airgradient_${this.config.serialNumber}`)) {
        this.deviceUrl = `http://${service.host}:${service.port}`;
        this.log.info(`Device found at ${this.deviceUrl}`);
        this.pollAirGradient();
        setInterval(() => this.pollAirGradient(), this.config.pollDelay);
      }
    });

    setTimeout(() => {
      if (!this.deviceUrl) {
        this.log.error('No device found: ', this.config.serialNumber);
      }
    }, 5000);
  }

  async pollAirGradient(): Promise<void> {
    this.log.debug('Polling data from AirGradient');
    try {
      const response = await axios.get(`${this.deviceUrl}/measures/current`);
      this.updateCharacteristics(response.data);
      this.isConnected = true;
    } catch (error) {
      this.isConnected = false;
    }
  }

  updateInfo(data: AirGradientData): void {
    // FIXME: Can only set these when the service is registered.
    // To update in Homebridge/Homekit, would need to removeService and re-register
    this.firmwareVersion = data.firmwareVersion;
    this.infoService.setCharacteristic(this.api.hap.Characteristic.FirmwareRevision, data.firmwareVersion);
    this.infoService.setCharacteristic(this.api.hap.Characteristic.Model, data.fwMode);
  }

  updateCharacteristics(data: AirGradientData): void {
    this.log.debug('Updating with new data: ', JSON.stringify(data, null, 2));
    if (data.boot === 0) {
      this.log.debug('Device still booting...');
      return;
    }

    if (data.firmwareVersion !== this.firmwareVersion) {
      this.updateInfo(data);
    }

    // Update Air Quality
    const airQuality = this.transformAirQuality(data.pm02, data.pm10, data.rco2);
    this.airQualityService
      .getCharacteristic(this.api.hap.Characteristic.AirQuality)
      .updateValue(airQuality as CharacteristicValue);

    // Update PM2.5 Density
    const pm25Density = data.pm02 as CharacteristicValue;
    this.airQualityService
      .getCharacteristic(this.api.hap.Characteristic.PM2_5Density)
      .updateValue(pm25Density);

    // Update PM10 Density
    const pm10Density = data.pm10 as CharacteristicValue;
    this.airQualityService
      .getCharacteristic(this.api.hap.Characteristic.PM10Density)
      .updateValue(pm10Density);

    // Update CO2 Level
    const co2Level = data.rco2 as CharacteristicValue;
    this.airQualityService
      .getCharacteristic(this.api.hap.Characteristic.CarbonDioxideLevel)
      .updateValue(co2Level);

    // Update Temperature
    const temperature = data.atmp as CharacteristicValue;
    this.temperatureService
      .getCharacteristic(this.api.hap.Characteristic.CurrentTemperature)
      .updateValue(temperature);
  }

  addHandlers(): void {
    this.airQualityService.getCharacteristic(this.api.hap.Characteristic.AirQuality)
      .onGet(this.handleAirQualityGet.bind(this));

    this.airQualityService.getCharacteristic(this.api.hap.Characteristic.CarbonDioxideLevel)
      .onGet(this.handleCarbonDioxideLevelGet.bind(this));

    this.airQualityService.getCharacteristic(this.api.hap.Characteristic.PM2_5Density)
      .onGet(this.handlePM25Get.bind(this));

    this.airQualityService.getCharacteristic(this.api.hap.Characteristic.PM10Density)
      .onGet(this.handlePM10Get.bind(this));

    this.temperatureService.getCharacteristic(this.api.hap.Characteristic.CurrentTemperature)
      .onGet(this.handleTemperatureGet.bind(this));
  }

  handleAirQualityGet(): Nullable<CharacteristicValue> {
    if (this.isConnected) {
      return this.airQualityService.getCharacteristic(this.api.hap.Characteristic.AirQuality).value;
    } else {
      throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  transformAirQuality(pm2_5: number, pm10: number, co2: number): number {
    let rank = 1; // Start with the best air quality rank

    // Rank for PM2.5 (µg/m3)
    if (pm2_5 > 100) {
      return 5;
    } else if (pm2_5 > 55.4) {
      rank = Math.max(rank, 4);
    } else if (pm2_5 > 35.4) {
      rank = Math.max(rank, 3);
    } else if (pm2_5 > 12) {
      rank = Math.max(rank, 2);
    }

    // Rank for PM10 (µg/m3)
    if (pm10 > 354) {
      return 5;
    } else if (pm10 > 254) {
      rank = Math.max(rank, 4);
    } else if (pm10 > 154) {
      rank = Math.max(rank, 3);
    } else if (pm10 > 54) {
      rank = Math.max(rank, 2);
    }

    // Rank for CO2 (ppm)
    if (co2 > 2000) {
      return 5;
    } else if (co2 > 1000) {
      rank = Math.max(rank, 3);
    } else if (co2 > 500) {
      rank = Math.max(rank, 2);
    }

    return rank;
  }

  handleCarbonDioxideLevelGet(): Nullable<CharacteristicValue> {
    if (this.isConnected) {
      return this.airQualityService.getCharacteristic(this.api.hap.Characteristic.CarbonDioxideLevel).value;
    } else {
      throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  handlePM25Get(): Nullable<CharacteristicValue> {
    if (this.isConnected) {
      return this.airQualityService.getCharacteristic(this.api.hap.Characteristic.PM2_5Density).value;
    } else {
      throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  handlePM10Get(): Nullable<CharacteristicValue> {
    if (this.isConnected) {
      return this.airQualityService.getCharacteristic(this.api.hap.Characteristic.PM10Density).value;
    } else {
      throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  handleTemperatureGet(): Nullable<CharacteristicValue> {
    if (this.isConnected) {
      return this.temperatureService.getCharacteristic(this.api.hap.Characteristic.CurrentTemperature).value;
    } else {
      throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  getServices(): Service[] {
    return [this.infoService, this.airQualityService, this.temperatureService];
  }
}

export = (homebridge: API) => {
  homebridge.registerAccessory('AirQualitySensor', AirQualitySensor);
};

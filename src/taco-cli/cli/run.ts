﻿/**
﻿ *******************************************************
﻿ *                                                     *
﻿ *   Copyright (C) Microsoft. All rights reserved.     *
﻿ *                                                     *
﻿ *******************************************************
﻿ */
/// <reference path="../../typings/tacoUtils.d.ts" />
/// <reference path="../../typings/node.d.ts" />
/// <reference path="../../typings/nopt.d.ts" />

"use strict";

import assert = require ("assert");
import path = require ("path");
import Q = require ("q");

import buildTelemetryHelper = require("./utils/buildTelemetryHelper");
import CleanHelperModule = require("./utils/cleanHelper");
import errorHelper = require ("./tacoErrorHelper");
import PlatformHelper = require ("./utils/platformHelper");
import RemoteBuildClientHelper = require ("./remoteBuild/remoteBuildClientHelper");
import RemoteBuildSettings = require ("./remoteBuild/buildSettings");
import resources = require ("../resources/resourceManager");
import Settings = require ("./utils/settings");
import TacoErrorCodes = require ("./tacoErrorCodes");
import tacoUtility = require ("taco-utils");

import BuildInfo = tacoUtility.BuildInfo;
import CleanHelper = CleanHelperModule.CleanHelper;
import commands = tacoUtility.Commands;
import CordovaWrapper = tacoUtility.CordovaWrapper;
import logger = tacoUtility.Logger;

import ICommandTelemetryProperties = tacoUtility.ICommandTelemetryProperties;

/**
 * Run
 *
 * handles "taco run"
 */
class Run extends commands.TacoCommandBase {
    private static KNOWN_OPTIONS: Nopt.CommandData = {
        local: Boolean,
        remote: Boolean,
        clean: Boolean,
        debuginfo: Boolean,
        nobuild: Boolean,
        list: Boolean,

        device: Boolean,
        emulator: Boolean,
        target: String,
        
        //livereload: Boolean,
        //devicesync: Boolean,

        // Are these only for when we build as part of running?
        debug: Boolean,
        release: Boolean
    };
    private static SHORT_HANDS: Nopt.ShortFlags = {};

    public name: string = "run";
    public info: commands.ICommandInfo;

    private static generateTelemetryProperties(telemetryProperties: tacoUtility.ICommandTelemetryProperties,
        commandData: commands.ICommandData): Q.Promise<tacoUtility.ICommandTelemetryProperties> {
        return buildTelemetryHelper.addCommandLineBasedPropertiesForBuildAndRun(telemetryProperties, Run.KNOWN_OPTIONS, commandData);
    }

    private targets(): Q.Promise<any> {
        return CordovaWrapper.targets(this.data);
    }

    private remote(): Q.Promise<tacoUtility.ICommandTelemetryProperties> {
        var commandData: commands.ICommandData = this.data;
        var telemetryProperties: tacoUtility.ICommandTelemetryProperties = {};
        return Q.all<any>([PlatformHelper.determinePlatform(commandData), Settings.loadSettingsOrReturnEmpty()])
            .spread((platforms: PlatformHelper.IPlatformWithLocation[], settings: Settings.ISettings) => {
                buildTelemetryHelper.storePlatforms(telemetryProperties, "actuallyBuilt", platforms, settings);

                return Run.cleanPlatformsIfNecessary(commandData, platforms).then(() => {
                    return Q.all(platforms.map(function (platform: PlatformHelper.IPlatformWithLocation): Q.Promise<any> {
                        assert(platform.location === PlatformHelper.BuildLocationType.Remote);
                        return Run.runRemotePlatform(platform.platform, commandData, telemetryProperties);
                    }));
                });                
            }).then(() => Run.generateTelemetryProperties(telemetryProperties, commandData));
    }

    private static runRemotePlatform(platform: string, commandData: commands.ICommandData, telemetryProperties: ICommandTelemetryProperties): Q.Promise<any> {
        return Q.all<any>([Settings.loadSettings(), CordovaWrapper.getCordovaVersion()]).spread<any>(function (settings: Settings.ISettings, cordovaVersion: string): Q.Promise<any> {
            var configuration: string = commandData.options["release"] ? "release" : "debug";
            var buildTarget: string = commandData.options["target"] || (commandData.options["device"] ? "device" : "");
            var language: string = settings.language || "en";
            var remoteConfig: Settings.IRemoteConnectionInfo = settings.remotePlatforms && settings.remotePlatforms[platform];
            if (!remoteConfig) {
                throw errorHelper.get(TacoErrorCodes.CommandRemotePlatformNotKnown, platform);
            }

            // DeviceSync/LiveReload not compatible with remote
            /*var deviceSync = commandData.options["livereload"] || commandData.options["devicesync"];
            if (deviceSync) {
                throw errorHelper.get(TacoErrorCodes.ErrorIncompatibleOptions, "--livereload/--devicesync", "--remote");
            }
            */

            var buildOptions: string[] = commandData.remain.filter(function (opt: string): boolean { return opt.indexOf("--") === 0; });
            var buildInfoPath: string = path.resolve(".", "remote", platform, configuration, "buildInfo.json");
            var buildInfoPromise: Q.Promise<BuildInfo>;
            var buildSettings: RemoteBuildSettings = new RemoteBuildSettings({
                projectSourceDir: path.resolve("."),
                buildServerInfo: remoteConfig,
                buildCommand: "build",
                platform: platform,
                configuration: configuration,
                buildTarget: buildTarget,
                language: language,
                cordovaVersion: cordovaVersion,
                options: buildOptions
            });

            // Find the build that we are supposed to run
            if (commandData.options["nobuild"]) {
                buildInfoPromise = RemoteBuildClientHelper.checkForBuildOnServer(buildSettings, buildInfoPath).then(function (buildInfo: BuildInfo): BuildInfo {
                    if (!buildInfo) {
                        // No info for the remote build: User must build first
                        var buildCommandToRun: string = "taco build" + ([commandData.options["remote"] ? " --remote" : ""].concat(commandData.remain).join(" "));
                        throw errorHelper.get(TacoErrorCodes.NoRemoteBuildIdFound, buildCommandToRun);
                    } else {
                        return buildInfo;
                    }
                });
            } else {
                // Always do a rebuild, but incrementally if possible.
                buildInfoPromise = RemoteBuildClientHelper.build(buildSettings, telemetryProperties);
            }

            // Default to a simulator/emulator build unless explicitly asked otherwise
            // This makes sure that our defaults match Cordova's, as well as being consistent between our own build and run.
            var runPromise: Q.Promise<BuildInfo>;
            if (commandData.options["device"]) {
                runPromise = buildInfoPromise.then(function (buildInfo: BuildInfo): Q.Promise<BuildInfo> {
                    return RemoteBuildClientHelper.run(buildInfo, remoteConfig);
                }).then(function (buildInfo: BuildInfo): BuildInfo {
                    logger.log(resources.getString("CommandRunRemoteDeviceSuccess"));
                    return buildInfo;
                });
            } else {
                runPromise = buildInfoPromise.then(function (buildInfo: BuildInfo): Q.Promise<BuildInfo> {
                    return RemoteBuildClientHelper.emulate(buildInfo, remoteConfig, buildTarget);
                }).then(function (buildInfo: BuildInfo): BuildInfo {
                    logger.log(resources.getString("CommandRunRemoteEmulatorSuccess"));
                    return buildInfo;
                });
            }

            return runPromise.then(function (buildInfo: BuildInfo): Q.Promise<BuildInfo> {
                if (commandData.options["debuginfo"]) {
                    // enable debugging and report connection information
                    return RemoteBuildClientHelper.debug(buildInfo, remoteConfig)
                        .then(function (debugBuildInfo: BuildInfo): BuildInfo {
                            if (debugBuildInfo["webDebugProxyPort"]) {
                                logger.log(JSON.stringify({ webDebugProxyPort: debugBuildInfo["webDebugProxyPort"] }));
                            }

                            return debugBuildInfo;
                        });
                } else {
                    return Q(buildInfo);
                }
            });
        });
    }

    private runLocal(localPlatforms?: string[]): Q.Promise<tacoUtility.ICommandTelemetryProperties> {
        var self = this;

        return Run.cleanPlatformsIfNecessary(this.data).then(() => {
            /*
            if (this.data.options["livereload"] || this.data.options["devicesync"]) {
                // intentionally delay-requiring it since liveReload fetches whole bunch of stuff
                var liveReload = require("./liveReload");
                return liveReload.hookLiveReload(!!this.data.options["livereload"], !!this.data.options["devicesync"], localPlatforms)
                    .then(() => CordovaWrapper.run(self.data, localPlatforms));
            }
            */
            return CordovaWrapper.run(this.data, localPlatforms);
        });
    }

    private local(): Q.Promise<tacoUtility.ICommandTelemetryProperties> {
        var commandData: commands.ICommandData = this.data;
        return this.runLocal()
            .then(() => Run.generateTelemetryProperties({}, commandData));
    }

    private static cleanPlatformsIfNecessary(commandData: commands.ICommandData, platforms?: PlatformHelper.IPlatformWithLocation[]): Q.Promise<any> {
        if (commandData.options["clean"]) {
            var determinePlatformsPromise: Q.Promise<PlatformHelper.IPlatformWithLocation[]>;

            if (platforms) {
                determinePlatformsPromise = Q(platforms);
            } else {
                determinePlatformsPromise = PlatformHelper.determinePlatform(commandData);
            }

            return determinePlatformsPromise.then((plats: PlatformHelper.IPlatformWithLocation[]) => {
                CleanHelper.cleanPlatforms(plats, commandData);
            });
        }

        return Q({});
    }

    private fallback(): Q.Promise<tacoUtility.ICommandTelemetryProperties> {
        var commandData: commands.ICommandData = this.data;
        var telemetryProperties: tacoUtility.ICommandTelemetryProperties = {};

        var self = this;
        return Q.all<any>([PlatformHelper.determinePlatform(commandData), Settings.loadSettingsOrReturnEmpty()])
            .spread((platforms: PlatformHelper.IPlatformWithLocation[], settings: Settings.ISettings): Q.Promise<any> => {
                buildTelemetryHelper.storePlatforms(telemetryProperties, "actuallyBuilt", platforms, settings);

                return Run.cleanPlatformsIfNecessary(commandData, platforms).then(() => {
                    return PlatformHelper.operateOnPlatforms(platforms,
                        (localPlatforms: string[]): Q.Promise<any> => self.runLocal(localPlatforms),
                        (remotePlatform: string): Q.Promise<any> => Run.runRemotePlatform(remotePlatform, commandData, telemetryProperties)
                    );
                });
        }).then(() => Run.generateTelemetryProperties(telemetryProperties, commandData));
    }

    public subcommands: commands.ISubCommand[] = [
        {
            // --list = targets
            name: "targets",
            run: () => this.targets(),
            canHandleArgs: () => !!this.data.options["list"]
        },
        {
            // Remote Run
            name: "remote",
            run: () => this.remote(),
            canHandleArgs: () => !!this.data.options["remote"]
        },
        {
            // Local Run
            name: "local",
            run: () => this.local(),
            canHandleArgs: () => !!this.data.options["local"]
        },
        {
            // Fallback
            name: "fallback",
            run: () => this.fallback(),
            canHandleArgs: () => true
        }
    ];

    public parseArgs(args: string[]): commands.ICommandData {
        var parsedOptions: commands.ICommandData = tacoUtility.ArgsHelper.parseArguments(Run.KNOWN_OPTIONS, Run.SHORT_HANDS, args, 0);

        // Raise errors for invalid command line parameters
        if (parsedOptions.options["remote"] && parsedOptions.options["local"]) {
            throw errorHelper.get(TacoErrorCodes.ErrorIncompatibleOptions, "--remote", "--local");
        }

        if (parsedOptions.options["device"] && parsedOptions.options["emulator"]) {
            throw errorHelper.get(TacoErrorCodes.ErrorIncompatibleOptions, "--device", "--emulator");
        }

        if (parsedOptions.options["debug"] && parsedOptions.options["release"]) {
            throw errorHelper.get(TacoErrorCodes.ErrorIncompatibleOptions, "--debug", "--release");
        }
        
        /*
        if (parsedOptions.options["livereload"] && parsedOptions.options["remote"]) {
            throw errorHelper.get(TacoErrorCodes.ErrorIncompatibleOptions, "--livereload", "--remote");
        }

        if (parsedOptions.options["devicesync"] && parsedOptions.options["remote"]) {
            throw errorHelper.get(TacoErrorCodes.ErrorIncompatibleOptions, "--devicesync", "--remote");
        }

        if (parsedOptions.options["devicesync"] && parsedOptions.options["livereload"]) {
            throw errorHelper.get(TacoErrorCodes.ErrorIncompatibleOptions, "--devicesync", "--livereload");
        }
        */
        
        if (parsedOptions.options["nobuild"] && parsedOptions.options["clean"]) {
            throw errorHelper.get(TacoErrorCodes.ErrorIncompatibleOptions, "--nobuild", "--clean");
        }

        return parsedOptions;
    }
}

export = Run;

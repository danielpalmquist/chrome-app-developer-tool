(function() {
    "use strict";
    /* global myApp */
    myApp.factory("AppsService", [ "ResourcesLoader", "INSTALL_DIRECTORY", "APPS_JSON", function(ResourcesLoader, INSTALL_DIRECTORY, APPS_JSON) {

        var platformId = cordova.platformId;
        // Map of type -> handler.
        var _installHandlerFactories = {};
        // functions to run before launching an app
        var preLaunchHooks = [];

        var _installHandlers = null;
        var _lastLaunchedAppId = null;

        function createInstallHandlersFromJson(json) {
            var appList = json['appList'] || [];
            var ret = [];
            for (var i = 0, entry; entry = appList[i]; ++i) {
                var factory = _installHandlerFactories[entry['appType']];
                var handler = factory.createFromJson(entry['appUrl'], entry['appId']);
                handler.lastUpdated = entry['lastUpdated'] && new Date(entry['lastUpdated']);
                ret.push(handler);
            }
            return ret;
        }

        function readAppsJson() {
            var deferred = Q.defer();
            ResourcesLoader.readJSONFileContents(APPS_JSON)
            .then(function(result) {
                deferred.resolve(result);
            }, function() {
                // Error means first run.
                deferred.resolve({});
            });
            return deferred.promise;
        }

        function initHandlers() {
            if (_installHandlers) {
                return Q();
            }

            return readAppsJson()
            .then(function(appsJson) {
                _lastLaunchedAppId  = appsJson['lastLaunched'];
                _installHandlers = createInstallHandlersFromJson(appsJson);
            });
        }

        function writeAppsJson() {
            var appsJson = {
                'lastLaunched': _lastLaunchedAppId,
                'appList': []
            };
            var appList = appsJson['appList'];
            for (var i = 0, handler; handler = _installHandlers[i]; ++i) {
                appList.push({
                    'appId' : handler.appId,
                    'appType' : handler.type,
                    'appUrl' : handler.url,
                    'lastUpdated': handler.lastUpdated && +handler.lastUpdated
                });
            }

            var stringContents = JSON.stringify(appsJson);
            return ResourcesLoader.writeFileContents(APPS_JSON, stringContents);
        }

        function isUrlAbsolute(path){
            return (path.match(/^[a-z0-9+.-]+:/) != null);
        }

        function getAppStartPageFromConfig(configFile, appBaseLocation) {
            appBaseLocation += (appBaseLocation.charAt(appBaseLocation.length - 1) === "/")? "" : "/";
            return ResourcesLoader.readFileContents(configFile)
            .then(function(contents){
                if(!contents) {
                    throw new Error("Config file is empty. Unable to find a start page for your app.");
                } else {
                    var startLocation = appBaseLocation + "index.html";
                    var parser = new DOMParser();
                    var xmlDoc = parser.parseFromString(contents, "text/xml");
                    var els = xmlDoc.getElementsByTagName("content");

                    if(els.length > 0) {
                        // go through all "content" elements looking for the "src" attribute in reverse order
                        for(var i = els.length - 1; i >= 0; i--) {
                            var el = els[i];
                            var srcValue = el.getAttribute("src");
                            if(srcValue) {
                                if(isUrlAbsolute(srcValue)) {
                                    startLocation = srcValue;
                                } else {
                                    srcValue = srcValue.charAt(0) === "/" ? srcValue.substring(1) : srcValue;
                                    startLocation = appBaseLocation + srcValue;
                                }
                                break;
                            }
                        }
                    }

                    return startLocation;
                }
            });
        }

        // On success, this function returns the following paths
        // appInstallLocation - INSTALL_DIR/app/platform/
        // platformWWWLocation - location containing the html, css and js files
        // configLocation - location of config.xml
        // startLocation - the path of the page to start the app with
        function getAppPathsForHandler(handler) {
            var appPaths = {};
            var installPath = INSTALL_DIRECTORY + '/' + handler.appId;
            appPaths.appInstallLocation = installPath;
            appPaths.configLocation = installPath + "/config.xml";
            appPaths.platformWWWLocation = installPath + "/www/";

            return Q.fcall(function(){
                return getAppStartPageFromConfig(appPaths.configLocation, appPaths.platformWWWLocation);
            })
            .then(function(startLocation){
                appPaths.startLocation = startLocation;
                return appPaths;
            });
        }

        function insertObjectAtPriority(objArr, handler, priority){
            var i = 0;
            var objToInsert = { "priority" : priority, "handler" : handler };
            for(i = 0; i < objArr.length; i++){
                if(objArr[i].priority > objToInsert.priority) {
                    break;
                }
            }
            objArr.splice(i, 0, objToInsert);
        }

        return {
            // return promise with the array of apps
            getAppList : function() {
                return initHandlers()
                .then(function() {
                    return _installHandlers.slice();
                });
            },

            launchApp : function(handler) {
                var appEntry;
                var startLocation;
                _lastLaunchedAppId = handler.appId;
                return writeAppsJson()
                .then(function(){
                    return getAppPathsForHandler(handler);
                })
                .then(function(appPaths){
                    startLocation = appPaths.startLocation;
                    var result = Q.resolve(0 /* dummy value to set up chain */);
                    preLaunchHooks.forEach(function (currHook) {
                        result = result.then(function(){
                            return currHook.handler(appEntry, appPaths.appInstallLocation, appPaths.platformWWWLocation);
                        });
                    });
                    return result;
                })
                .then(function() {
                    window.location = startLocation;
                });
            },

            addApp : function(installerType, appUrl) {
                var handlerFactory = _installHandlerFactories[installerType];
                return Q.fcall(function(){
                    return handlerFactory.createFromUrl(appUrl);
                })
                .then(function(handler) {
                    _installHandlers.push(handler);
                    return writeAppsJson()
                    .then(function() {
                        return handler;
                    });
                });
            },

            uninstallApp : function(handler) {
                _installHandlers.splice(_installHandlers.indexOf(handler), 1);
                return writeAppsJson()
                .then(function() {
                    var installPath = INSTALL_DIRECTORY + '/' + handler.appId;
                    return ResourcesLoader.deleteDirectory(installPath);
                });
            },

            getLastRunApp : function() {
                throw new Error('Not implemented.');
            },

            updateApp : function(handler){
                return Q.fcall(function() {
                    var installPath = INSTALL_DIRECTORY + '/' + handler.appId;
                    return handler.updateApp(installPath);
                });
            },

            registerInstallHandlerFactory : function(handlerFactory) {
                _installHandlerFactories[handlerFactory.type] = handlerFactory;
            },

            addPreLaunchHook : function(handler, priority){
                if(!priority) {
                    // Assign a default priority
                    priority = 500;
                }
                insertObjectAtPriority(preLaunchHooks, handler, priority);
            }
        };
    }]);
})();
